# Design: carry the draft on the abort, not in a side map

**Date:** 2026-07-15 (revision 2 — folds in the review findings and the full `finalize` design worked out in discussion)
**Status:** Agreed design. Supersedes the storage architecture shipped in the `saveDraft` PR (#551) and the salvage semantics in `2026-07-14-save-draft-guards-design.md`.
**Related:** `lib/runtime/drafts.ts` (the code this replaces).

## What we are solving

Guards are binary. A `guard(cost:, time:)` block runs until it exceeds its budget. When it trips, it returns a failure, and the work the block had done is thrown away.

`saveDraft(v)` gives the block an anytime-algorithm floor. Code records a best-so-far value as it works. When the guard trips, the guard returns a saved value instead of a failure. A research loop can save its draft report on every pass, and a five-minute budget then returns the best report so far rather than nothing.

The shipped version (#551) builds this with a side map: drafts keyed by frame depth, a region marker per guard, a search at the boundary, a sweep, two clearing paths in generated code, and a memoized workaround for a resume bug. Almost all of that machinery exists to answer one question: of all the frames the trip just killed, whose draft should the guard return? The guard ends up owning a ledger for its whole call tree. That is the wrong shape. A draft belongs to the scope that saved it. This redesign makes each scope handle its own draft and deletes the ledger.

## The core mechanism: a carried draft on the abort

When a guard trips, the runtime throws an error. That error is an object, and it travels up through every function between the trip and the guard. Because it is an object, we can attach a value to it:

```ts
error.carriedDraft = { value: ... }   // "the best partial result so far"
```

Each function the error passes through updates the carried draft, and the guard reads the carried draft when it catches the trip. That is the whole mechanism. `saveDraft(v)` itself does one thing: it sets a `savedDraft` slot on the current frame. No map, no depth, no region.

Naming: both fields hold the same kind of thing — a draft, meaning a function's best-so-far return value. The names mark the stage, not the kind. `savedDraft` is a draft filed at a level, sitting on its frame. `carriedDraft` is a draft in transit, riding the abort between two levels. A finalize's return value is also a draft in this sense: it is the frame's freshest draft, computed at the moment of death, and it goes straight onto `carriedDraft` without ever being filed (its only consumer is one level up, and the frame producing it is being popped).

## The level rule

The error passes through functions one at a time, innermost first. Each function replaces the carried draft with **its own** partial value, always:

1. **If it has a `finalize` block:** run it. The carried draft becomes whatever the finalize returns.
2. **Else, if it saved a draft:** the carried draft becomes that draft.
3. **Else, if the trip escaped through a call in `return` position:** the carried draft passes through unchanged. `return verify()` declares that verify's value IS this function's value, and the checker enforced the types. So verify's forced return is this function's forced return.
4. **Else: the carried draft becomes empty.**

Rule 4 is load-bearing. A function with nothing to say **erases** the carried draft. A partial value crosses one level at a time, and only because the receiving level chose to pass something on — by re-saving it, translating it in a finalize, or having declared `return callee()` up front. An inner function's partial can never skip levels and reach the guard untyped.

### Return-position pass-through: how it works

The catch rung cannot know which statement the error escaped from, so the compiler marks the abort at the call site. A call in `return` position compiles with a small wrapper that sets a transient `returnCarry` flag on a passing abort; the frame's rung consumes the flag (reads it, then clears it) when applying rule 3. Consume-once per level, like the carried draft itself, so the flag can never skip a level.

The mark wraps only the OUTERMOST call of the return expression, and argument subexpressions are evaluated before the wrapper is entered. So in `return f(g())`: if `g` trips, the abort is unmarked (g never made it into return position; g's type has no relation to this function's return type) and rule 4 erases. If `f` trips, the abort is marked and f's draft — f-return-typed, which is exactly this function's return type — passes through. This is what keeps the type-safety induction intact.

When the error reaches the guard, the guard reads the carried draft. If there is a carried draft, the guard returns it as a success. If not, the guard returns the failure, exactly as today.

### Walked example: both levels save

```
guard(time: 5m) as {
  return code()
}
def code() {
  saveDraft(10)
  const x = verify()   // the trip unwinds through here
}
def verify() {
  saveDraft(1)
  // the trip happens here
}
```

1. The error leaves `verify`. `verify` saved a draft. Carried draft = `1`.
2. The error leaves `code`. `code` saved a draft, so it replaces the carried draft. Carried draft = `10`. The `1` is gone — the only thing it could ever have done is be read by a `finalize` in `code`, and `code` has none.
3. The error leaves the guard block. The block saved nothing and has no finalize, but `return code()` is a return-position call, so rule 3 passes the carried draft through. Still `10`. (This hop is why rule 3 exists: without it, the block level — which almost never saves a draft of its own — would erase every draft on its way to the guard, and this example would return a failure.)
4. The guard reads the carried draft and returns `success(10)`.

### Walked example: only the deep level saves

Same program, but `code` never calls `saveDraft` and has no finalize.

1. The error leaves `verify`. Carried draft = `1`.
2. The error leaves `code`. `code` has nothing to say, and the trip escaped through `const x = verify()` — an assignment, not a return-position call — so rule 3 does not apply. Carried draft = empty. (Had `code` written `return verify()` instead, the `1` would have passed through.)
3. The guard reads nothing and returns the **failure**.

`verify`'s partial existed, but `code` declined to translate it, so it died at `code`'s boundary. This is a deliberate behavior change from #551, which would have returned `1` here (its "outermost-set draft" search falls back to deeper drafts). Salvage is now opt-in per level.

### The type-safety caveat is gone

Earlier versions of this design documented a limitation: a deep draft could reach the guard unopposed and might not match the type the guard block returns. The level rule deletes that limitation instead of documenting it. By induction: a function's partial is its `saveDraft` value, which the checker verifies against its return type; or its finalize's return, which the checker also verifies against its return type; or a callee's partial passed through a return-position call, where the checker already verified the callee's return type matches this function's. So the carried draft always holds a value typed for the frame the error most recently left, and the guard only ever sees a value typed for its own block.

## When a draft becomes a real return value

The model (owner's framing, adopted): a trip does not prevent a function from returning. It forces an **early return**, and the function's draft is what it returns — its finalize result if it has one, else its saved draft, else its callee's forced return when the trip crossed a return-position call, else nothing. `carriedDraft` is that forced return value in transit to the caller. (Pass-through is not a conversion point: the value stays a shadow value; it just crosses a level that had pre-declared identity with its callee.)

But a forced return value is a shadow value: the program's normal code never sees it. It is visible in exactly two places, and each place is a conversion point:

1. **A finalize's bound local.** When the caller has a finalize, the callee's forced return lands in the local its call was headed for (`const x = verify()` → `x` holds verify's forced return). The finalize consumes it and its own return becomes the caller's forced return. This converts the value one level up — it is still a shadow value above that.
2. **The guard boundary.** The guard's owned-trip conversion turns the carried draft into `success(draft)` — an ordinary value the program continues with. This is the only place today where a draft stops being a shadow value.

The fork boundary is not a conversion point. It discards a branch's carried draft, because one branch's value is the wrong shape for the fork and which branch fails first is nondeterministic.

Future conversion points, deferred: the root-budget exit reporter (print the best-so-far before exit 3) and fork-array salvage (branch drafts collected into the fork's `T[]` shape).

## How the tricky cases resolve

**Nested guards.** An inner guard catches its own abort and turns it into a value. When the outer guard later trips, that is a different error object with its own carried draft. An abort physically cannot carry a draft from outside its own path.

**Sequential guards.** Guard A trips on error A; guard B trips later on error B. Separate objects, separate carried drafts. No sweep needed.

**A finished sibling.** `a = code(); b = code()` inside one guard, where the first call finishes and the second trips. The first call returned normally, so no error ever passed through it and its draft died with its frame. The stale-sibling hazard cannot occur, so the clearing rule is unnecessary.

**A plain error, not an abort.** When a function body throws an ordinary exception, the generated catch converts it into a failure, exactly as today — the draft is not consulted. This is deliberate, for two reasons. First, trust: an abort interrupts healthy code from the outside, so the work done so far is presumptively good; a thrown error means the code itself broke, and a draft saved by code that then proved broken is not a value to hand out as a success. Second, there is no carrying problem to solve: a failure does not skip levels the way an abort does. It becomes a value at the very next frame, and the caller already has ordinary code paths to react to it. If error-path salvage is ever wanted, the additive design is to attach the draft to the failure's data so callers can opt in — never to convert the failure into a success.

**Interrupt and resume.** An interrupt is not an abort; it pauses the block and no carried draft is touched. The draft sits on its frame, the frame serializes, and the draft survives the pause. After resume, a later trip stamps the restored draft. There is no region marker, so #551's resume workaround has nothing to work around.

**Fork and race branches — one deliberate line required.** Branch isolation is NOT automatic under this design, and the first draft of this doc was wrong to claim it. In #551, isolation came from storage: drafts lived on per-branch stacks the parent boundary could not see. The carried draft travels *on the error object*, and a branch's error object crosses the stack boundary: when a trip fires inside a branch, the branch's frames stamp their drafts, `runBatch` rethrows that same object at the join, and it arrives at the outer guard carrying a branch's draft. That is wrong twice over: the guard block's type is the fork's shape, not one branch's value, and in `all` mode whichever branch rejects first wins, which is nondeterministic. The fix is one line with a comment: `runBatch` clears the carried draft when it rethrows a rejected branch's error. Branch drafts stay inside their branch, matching the shipped scoping. A future fork-array salvage (each branch's partial collected into the fork's `T[]` shape) remains the principled extension and stays deferred.

## `finalize`: consuming a partial instead of overwriting it

Rule 1 above is the future feature, fully designed here so the carried-draft mechanism is built with the right slot. A finalize block lets a function *read* its callee's partial and translate it into its own return type, instead of blindly replacing it.

### The mechanism is catch, run, re-throw

Nothing can run "while an exception propagates" in any language. Destructors, `defer`, `finally` — all of them are code the compiler plants in each frame's catch or finally, and propagation is a chain of catch → do the frame's work → re-throw. Agency's generated code already has exactly this structure: the catch rung that re-throws `AgencyAbort` untouched. The carried draft stamp goes in that rung, and `finalize` is the same rung with user code in it:

```ts
catch (__error) {
  if (__error instanceof AgencyAbort) {
    if (/* this frame declared a finalize */) {
      __error.carriedDraft = { value: await __runFinalize() };   // rule 1
    } else if (__stack.savedDraft !== undefined) {
      __error.carriedDraft = __stack.savedDraft;                  // rule 2
    } else if (!__error.returnCarry) {                            // rule 3: return-position pass-through
      __error.carriedDraft = undefined;                           // rule 4: erase
    }
    __error.returnCarry = false;                                  // consume-once
    throw __error;
  }
  ...
}
```

The unwind order gives composition for free: inner finalizes run before outer ones, so each finalize receives a value the level below already translated.

### The finalize sees the function's locals, with partials bound in

A finalize does not take the partial as an argument, because a bare value answers nothing: a function with several calls cannot tell which callee the value came from. Instead the finalize reads the function's **locals**, exactly like any other code in the function — and the local whose call was killed holds that call's partial.

```
def code(): Report {
  const base = buildBase()
  const x = verify()          // trip happens inside verify
  return assemble(base, x)

  finalize {
    if (x != null) { return mergePartial(base, x) }   // x holds verify's partial
    return base
  }
}
```

This costs almost no new machinery, because locals already live on the frame. Generated code compiles `x` to `__stack.locals.x` everywhere, and the finalize body compiles the same way, in the same frame. What is new is the **binding**: delivering a killed call's partial into the local it was headed for. The compiler wraps each call expression in a function that has a finalize:

```ts
try {
  __stack.locals.x = await __call(verify, ...);
} catch (e) {
  if (e instanceof AgencyAbort) {
    __stack.locals.x = e.carriedDraft ? e.carriedDraft.value : null;
  }
  throw e;
}
```

Binding rules:

- **Per call expression, consume once, innermost first.** In `const x = f(g())`, if `g` trips, g's call site claims the carried draft. It has no variable, so the partial is dropped and `x` stays null. If `f` trips, f's call site claims the carried draft and `x` holds f's partial. This matters: binding per assignment statement instead would shove g's partial into an f-typed variable.
- **A local whose statement never ran is undefined** — which falls out for free, since the assignment simply never executed.
- **A bare call's partial is dropped.** `verify()` with no assignment has nowhere to put it.
- Partials are type-correct by the induction above: f's partial is f-return-typed, which is exactly the bound variable's declared type.

### Surface syntax and namespace

- **`finalize` is a keyword, not a stdlib function.** This is forced by the locals decision: a stdlib function's block would get its own frame and could not see the enclosing function's locals. `finalize` compiles into the function's own catch path and runs in the function's own frame, like `handle` and `thread` bodies run in theirs.
- **At most one per function.** A single block can branch internally; two blocks would need merge rules. The checker rejects a second.
- **Top level of the function body only** — never nested in an `if` or loop. A conditionally-armed finalize would need "was it armed?" semantics, registration timing, and a serialized flag. Declaration semantics avoid all of it: if the function has a finalize, it is always active.
- **Position is free; the convention is last.** It is a declaration, so placement changes nothing; the formatter and style guide put it at the end, where it reads as an epilogue.
- **Works in defs, nodes, and guard blocks.** A guard block is a frame with the same catch path.
- **Namespace split is principled: values are imports, control flow is syntax.** `saveDraft` stays in `std::thread` next to `guard`. `finalize` joins `handle` in the grammar. Nobody imports `handle`; nobody imports `finalize`.

### Rules for the finalize body

- **A finalize error never masks the trip.** If the finalize throws, log it through statelog, fall back as if the finalize did not exist — the frame's own draft if it saved one, else erase — and keep unwinding with the original abort. The original failure is the story; the salvage failure is a footnote.
- **No interrupts.** The body runs in a catch rung with no step counters, so there is nothing for a resume to replay back to. Statically checked, reusing the machinery that already forbids interrupts in callback bodies.
- **No `saveDraft`.** The carried draft is being computed at that moment; saving a draft there is meaningless. Checker error.
- **v1 keeps finalize computational.** The tripped guard's abort signal is still firing while the finalize runs, so any leaf operation inside it — `llm()`, `sleep()`, a fetch — would be cancelled immediately. For now that is the documented behavior: write finalize bodies as pure computation over locals. Shielding the signal and giving finalize a small grace budget (the SIGTERM-handler pattern) are designed but deliberately deferred; they add real complication and nothing in v1 needs them.

### Type checker changes

For `saveDraft` (shipped in #551; survives unchanged): the argument must be assignable to the enclosing scope's return type, including guard blocks, whose return type is inferred from their `return` statements. Aliasing (`const s = saveDraft`) escapes the name-keyed check; documented.

For `finalize`:

1. Its `return` values check against the enclosing function's return type — the same contract as ordinary `return`, same machinery.
2. Inside the body, every local is `T | null`. Any statement might not have run. Users narrow with a null check, which existing flow narrowing supports. Partials do not degrade locals to `any` — the induction above keeps them return-typed.
3. Structural: at most one per scope; top level only; no interrupts; no `saveDraft`.

## What changes from the shipped version (#551)

- **`saveDraft`** sets a serialized `savedDraft` slot on the calling frame instead of writing to `stack.other.drafts`. Clone-on-save behavior is kept.
- **The generated def catch rung** (`functionCatchFailure.mustache`) applies the level rule — finalize, else draft, else erase — before re-throwing. This replaces the def clearing path.
- **Blocks gain a catch.** `blockSetup.mustache` is try/finally today with no catch at all; the first draft of this doc wrongly assumed a "matching block handler" exists. The template gains a catch that applies the same level rule and re-throws; the finally still pops. This replaces the block clearing path — and it is where the flagship case (a `saveDraft` directly inside the guard block) gets its stamp.
- **The guard boundary** (`__tryCall`'s owned-guard conversion) reads the carried draft off the abort and returns a success when one is present. This replaces the region search and the sweep.
- **`runBatch`** clears the carried draft when rethrowing a rejected branch's error (the fork isolation line above).
- **`lib/runtime/drafts.ts` is deleted**: the store, regions, `salvageOwnTrip`, the memo, all of it. The two shipped review findings on that module (the empty-`ids` region collision and the region-key leak) become moot — a disabled guard owns no trips and simply passes the carried draft through to whoever does.
- **Behavior change:** the deep-fallback salvage is removed (see the second walked example). No shipped fixture pins the old behavior.
- **Tests:** the 13 execution fixtures stay and keep their meaning — stale-sibling and stale-block now pass because the hazard is impossible rather than because a rule handles it; update their comments to say so. The 14 `drafts.ts` unit tests die with the module, replaced by a handful of carried-draft-stamp unit tests. New fixtures: (a) a branch-originated trip under a guard outside the fork, expecting no salvage — the existing guard-outside-fork fixture only covers a parent-side trip; (b) only-deep-level-saves, expecting the failure, pinning the level rule.
- `finalize` ships as a separate increment on top of this; everything in its section above is settled design, not open questions.

## What statelog sees

Every partial that moves is observable. The rungs do not assign the carried draft inline; they call one runtime helper, and that helper is the statelog chokepoint.

- The first stamp that involves a partial opens an `abortUnwind` span and stores its id on the abort. An unwind through undrafted code opens nothing and logs nothing.
- Each level-rule transition that involves a partial emits one `abortSalvage` event inside that span: `carried` (this frame put its draft or finalize result on the carried draft), `passedThrough` (a return-position call let the callee's partial cross this level unchanged), `erased` (this frame killed a partial by having nothing to say), or `clearedAtFork` (a branch's partial was dropped at the fork boundary). The event carries the scope's name, its arguments, and the partial value — all as previews truncated at 500 characters, while the carried draft itself keeps the full value.
- Delivery — the guard turning the abort into a value — emits a final `delivered` event with what the guard returned, and closes the span.

So the log answers, for any trip: which drafts existed, which level dropped which partial and where, and what the guard finally handed back.

## Implementation notes to confirm

- A guard trip arrives in two shapes — a thrown `GuardExceededError` from the runner, and a cancelled leaf op carrying a `guardTrip` cause. Both are `AgencyAbort` values unwinding through the same catch rungs, so both pick up the carried draft. Confirm with the existing time-trip fixture.
- The carried draft lives as a mutable field on the `AgencyAbort` object. Every rung re-throws the same object, which is what makes the level rule's replace-and-erase work. This is the same idiom the abort taxonomy already uses: `AbortCause` rides the abort, and its `delivered` flag relies on the same shared identity.
- Only generated code has catch rungs, so the carried draft changes hands exactly at user-visible scopes. Runtime-internal frames, like the one an in-flight `llm()` runs on, never touch it.
- The `savedDraft` slot on the frame must join `State.toJSON`/`fromJSON` so it survives interrupt/resume.
- Aborts do not cross the subprocess IPC boundary as live objects, so a child process's drafts die with the child. Same as #551; unchanged.

## Deferred, with homes

- **Fork-array salvage:** each branch's partial collected into the fork's `T[]` shape, feeding the enclosing finalize. Needs the branch-boundary carried-draft handling above as its seam.
- **Finalize shielding + grace budget:** detach the tripped guard's signal around the finalize and arm a small fresh `TimeGuard` — the SIGTERM-handler pattern. Punted from v1 for complexity.
- **Root budgets:** a `--max-cost`/`--max-time` trip escapes to the compiled entry's catch carrying the carried draft, so `reportBudgetExceededAndExit` could print the best-so-far before exiting 3. Cheap once this lands; out of scope now.
- **Resumable guards (trips as interrupts):** fully designed in `2026-07-15-resumable-guards-design.md` — a handler can approve a trip with fresh budget allowances and an injected feedback message, or reject it, which delivers the abort at the paused point and runs THIS spec's machinery unchanged. Ships after this spec's PRs.
- `sigint`/`sigkill`, `saveDraft` as an LLM tool, a `Both` result type, and generalizing beyond guard trips (Esc, cancel, race-loss — the rung is cause-agnostic, so this is a policy check on `readCause`): unchanged from the original spec.
