# Design: an aborted function returns its draft (carry-on-abort, revision 3)

**Date:** 2026-07-15 (revision 3 — the abort now travels as a RETURN VALUE between frames, not as an exception; reworked from PR #553's review round. Revision 2 folded in the review findings and the full `finalize` design.)
**Status:** Agreed design. Supersedes the storage architecture shipped in the `saveDraft` PR (#551) and the salvage semantics in `2026-07-14-save-draft-guards-design.md`.
**Related:** `lib/runtime/drafts.ts` (the code this replaces).

## What we are solving

Guards are binary. A `guard(cost:, time:)` block runs until it exceeds its budget. When it trips, it returns a failure, and the work the block had done is thrown away.

`saveDraft(v)` gives the block an anytime-algorithm floor. Code records a best-so-far value as it works. When the guard trips, the guard returns a saved value instead of a failure. A research loop can save its draft report on every pass, and a five-minute budget then returns the best report so far rather than nothing.

The shipped version (#551) builds this with a side map: drafts keyed by frame depth, a region marker per guard, a search at the boundary, a sweep, two clearing paths in generated code, and a memoized workaround for a resume bug. Almost all of that machinery exists to answer one question: of all the frames the trip just killed, whose draft should the guard return? The guard ends up owning a ledger for its whole call tree. That is the wrong shape. A draft belongs to the scope that saved it. This redesign makes each scope handle its own draft and deletes the ledger.

## The core mechanism: an aborted function RETURNS its draft

When a function gets aborted, it does not throw past its own frame. The frame catches the abort and returns an `AbortedResult` instead: a marker that says "my run was aborted", the cause, and the frame's saved draft as its partial. Callers receive it like any other return value. The generated check that already runs after every call (the same place interrupts are checked) spots the marker, and the caller stops too, returning its OWN AbortedResult. So an abort travels up the stack as a plain value, exactly the way interrupts do.

```ts
// what a caller sees after `const x = verify()` when verify was aborted
if (isAborted(x)) {
  runner.halt(x.carryThrough(__stack, "code"));   // stop too, with MY draft
  return;
}
```

Exceptions still exist, but only inside a single frame: a cancelled in-flight `llm()` rejects, and the frame that was running converts that rejection into the value at its own catch (`AbortedResult.fromError`). Above node level — the graph engine, the CLI entry, root budgets — aborted values are converted back into exceptions, so everything outside compiled code behaves exactly as before.

`saveDraft(v)` itself does one thing: it records a `savedDraft` slot on the calling frame (`StateStack.setSavedDraft`). No map, no depth, no region — and no shared mutable object riding an exception. Every `AbortedResult` is immutable; each hop up the stack builds a new one.

Naming: both fields hold the same kind of thing — a draft, meaning a function's best-so-far return value. `savedDraft` is a draft filed on a frame, waiting. An `AbortedResult`'s `partial` is a draft in transit, being returned. A finalize's return value (future) is also a draft in this sense: the frame's freshest one, computed at the moment it stops.

## The level rule

Every rule is now a consequence of "an aborted function returns its draft" plus where the returned value lands. Nothing is flag-based; there is no case enumeration in the compiler.

1. **The frame where the abort strikes** returns its saved draft (or nothing) — `AbortedResult.fromError` at the frame's own catch.
2. **A caller that receives an aborted result at a statement** (`const x = verify()`, or a bare call) stops and returns ITS OWN saved draft — `carryThrough`. The callee's partial is dropped here: salvage is opt-in per level.
3. **Return position passes through structurally.** `return verify()` compiles to "halt with verify's result" — when that result is an AbortedResult, returning it IS the pass-through. No code runs, no flag, no marking. This mirrors the success path exactly: `return verify()` returns verify's value, aborted or not.
4. **Argument position drops at the call boundary.** In `f(g())` with g aborted, the aborted value would arrive as f's ARGUMENT. `__call` refuses to run and forwards the abort with the partial dropped, because an argument-position partial is typed for g, not for f's return. This lives at the one runtime chokepoint every call shape goes through — nested arguments, method chains, named arguments — so no compiler analysis can miss a case.

A partial still crosses one level at a time, and only because the receiving level passes it on: by declaring `return callee()`, by re-saving, or (future) by translating it in a finalize. An inner partial can never skip levels and reach a guard untyped.

**One semantic refinement over revision 2:** at return position the CALLEE's partial now wins even when the caller also saved a draft. Revision 2 ranked "own draft" above pass-through; the value transport exposes that ranking as an artifact of exception thinking. On success, `return verify()` returns verify's value and the caller's draft dies unused — the abort path now mirrors it. (No fixture pinned the old ordering; the walked examples are unaffected.)

When the aborted value reaches the guard that owns the trip, the guard salvages: `success(partial)` when one arrived, exactly the old failure when none did.

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

1. The abort strikes inside `verify`. verify's frame converts it: verify RETURNS an aborted result whose partial is `1`.
2. `code` receives it at `const x = verify()` — a statement, not a return. code stops and returns its own draft instead: partial = `10`. The `1` is gone — the only thing it could ever have done is be read by a `finalize` in `code`, and `code` has none.
3. The guard block's `return code()` returns code's result as-is — return position is pass-through by construction. Still `10`.
4. The guard salvages `success(10)`.

### Walked example: only the deep level saves

Same program, but `code` never calls `saveDraft` and has no finalize.

1. The abort strikes inside `verify`; verify returns an aborted result with partial `1`.
2. `code` receives it at `const x = verify()` — a statement. code stops with its own draft, which is nothing. Partial gone. (Had `code` written `return verify()` instead, the `1` would have passed straight through.)
3. The guard sees no partial and returns the **failure**.

`verify`'s partial existed, but `code` declined to translate it, so it died at `code`'s boundary. This is a deliberate behavior change from #551, which would have returned `1` here (its "outermost-set draft" search falls back to deeper drafts). Salvage is now opt-in per level.

### The type-safety caveat is gone

Earlier versions of this design documented a limitation: a deep draft could reach the guard unopposed and might not match the type the guard block returns. The level rule deletes that limitation instead of documenting it. By induction: a function's partial is its `saveDraft` value, which the checker verifies against its return type; or its finalize's return, which the checker also verifies against its return type; or a callee's partial passed through return position, where the checker already verified the callee's return type matches this function's. Argument-position partials — the one place a wrongly-typed value could sneak through — are dropped at the call boundary itself. So an aborted result's partial is always typed for the frame that returned it, and the guard only ever sees a value typed for its own block.

## When a draft becomes a real return value

The model (owner's framing, adopted): a trip does not prevent a function from returning. It forces an **early return**, and the function's draft is what it returns — its finalize result if it has one, else its saved draft, else, at a return-position call, whatever its callee's forced return was, else nothing. Revision 3 makes this framing LITERAL: the `AbortedResult` is that forced return value, actually returned. (Pass-through is not a conversion point: the value stays a shadow value; it just flows through a return statement like any other value.)

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

**Fork and race branches.** An aborted branch fulfills with an AbortedResult (its compiled frames convert aborts to values). At the fork boundary — one `.then` in `startInvoke`, the single point every branch's result passes through — that value becomes a rejection again, with the partial dropped (`atForkBoundary`). Two things fall out. Isolation: branch drafts stay inside their branch, because one branch's value has the wrong shape for the fork and which branch fails first is a race. Simplicity: every join path (all / sequential / race, first-run and resume) already handles branch rejections, so none of them need to know aborted values exist — and an aborted value can never be cached as a branch result. A future fork-array salvage (each branch's partial collected into the fork's `T[]` shape) remains the principled extension and stays deferred.

## `finalize`: consuming a partial instead of overwriting it

Rule 1 above is the future feature, fully designed here so the carried-draft mechanism is built with the right slot. A finalize block lets a function *read* its callee's partial and translate it into its own return type, instead of blindly replacing it.

### The mechanism: run the finalize where the frame stops

A frame stops in exactly two places: its own catch (the abort struck here) and the post-call check (a callee handed back an aborted result). Both places currently build the frame's AbortedResult from its saved draft; with a finalize declared, they build it from the finalize's return instead:

```ts
// at the frame's own catch
if (__error instanceof AgencyAbort) {
  return AbortedResult.fromError(__error, __stack, "code")
    .withFinalize(await __finalize());
}
// at the post-call check
if (isAborted(x)) {
  runner.halt(x.carryThrough(__stack, "code").withFinalize(await __finalize()));
  return;
}
```

(Exact method shape to be settled in PR B's plan; the point is that finalize slots into the two existing stop sites — no new control flow.) Composition comes for free: an inner function's finalize has already produced its partial by the time the caller's stop site runs, so each finalize receives a value the level below already translated.

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

This costs almost no new machinery, because locals already live on the frame — and under the value transport, the binding is nearly free. The callee's aborted result is ALREADY the value of the assignment (`__stack.locals.x = await __call(verify, ...)` assigns it before the post-call check runs). In a finalize-bearing scope, the check unwraps it into the local instead of discarding it:

```ts
__stack.locals.x = await __call(verify, ...);
if (isAborted(__stack.locals.x)) {
  const __abortedCallee = __stack.locals.x;
  __stack.locals.x = __abortedCallee.partial ? __abortedCallee.partial.value : null;
  runner.halt(__abortedCallee.carryThrough(__stack, "code").withFinalize(await __finalize()));
  return;
}
```

Binding rules — all of them now structural:

- **In `const x = f(g())`, if `g` aborts,** the call boundary drops g's partial before f would run (argument-position rule), so `x` holds null in the finalize. If `f` aborts, its aborted result IS the assignment's value, and `x` holds f's partial. No consume-once flag needed: there is only ever one aborted result in flight per statement.
- **A local whose statement never ran is undefined** — the assignment simply never executed.
- **A bare call's partial is dropped** — the statement-site check discards it (nothing was being assigned).
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
- **The generated def catch** (`functionCatchFailure.mustache`) converts a caught abort into a returned `AbortedResult` carrying the frame's draft, instead of re-throwing. Blocks gain the same catch (`blockSetup.mustache` was try/finally only) — that is how a `saveDraft` directly inside a guard block reaches the guard.
- **The post-call check** (the same emission point as the interrupt check) propagates a callee's aborted result: the caller stops with its own draft via `carryThrough`.
- **The call boundary** (`__call`/`__callMethod`) refuses aborted arguments and forwards the abort with the partial dropped.
- **The guard boundary** (`__tryCall`'s owned-guard conversion) salvages the aborted value's partial as a success when one arrived. This replaces the region search and the sweep. A thin exception backstop remains for trips thrown from runtime code with no compiled frame in between.
- **`runBatch`** converts an aborted branch value back into a rejection at `startInvoke`, partial dropped (the fork section above).
- **`lib/runtime/drafts.ts` is deleted**: the store, regions, `salvageOwnTrip`, the memo, all of it. The two shipped review findings on that module (the empty-`ids` region collision and the region-key leak) become moot — a disabled guard owns no trips and simply passes the aborted value through to whoever does.
- **Behavior change:** the deep-fallback salvage is removed (see the second walked example). No shipped fixture pins the old behavior.
- **Tests:** the 13 execution fixtures stay and keep their meaning — stale-sibling and stale-block now pass because the hazard is impossible rather than because a rule handles it; update their comments to say so. The 14 `drafts.ts` unit tests die with the module, replaced by a handful of carried-draft-stamp unit tests. New fixtures: (a) a branch-originated trip under a guard outside the fork, expecting no salvage; (b) only-deep-level-saves, expecting the failure, pinning the level rule; (c) a return chain carrying a deep draft to the guard, pinning structural pass-through; (d) argument-position aborts — both the cross-type repro from the PR-553 review (partial dropped at the call boundary) and the outer call of `return f(g())` tripping (its partial passes through).
- `finalize` ships as a separate increment on top of this; everything in its section above is settled design, not open questions.

## What statelog sees

Every partial that moves is observable. The `AbortedResult` methods are the statelog chokepoint — each hop that touches a partial logs itself, so no caller has to remember to.

- The first hop that involves a partial opens an `abortUnwind` span, whose id rides on the value. An abort through undrafted code opens nothing and logs nothing.
- Each hop that touches a partial emits one `abortSalvage` event: `carried` (a frame attached its draft — or, future, its finalize result), `erased` (a frame dropped a callee's partial by having none of its own), `droppedAtArgPosition` (an aborted value tried to enter a call as an argument), `clearedAtFork` (a branch's partial stopped at the fork boundary), and `delivered` (the guard salvaged it). Events carry the scope's name, its arguments, and the partial — previews truncated at 500 characters, while the value itself stays whole. Return-position pass-through is silent on purpose: no code runs there, exactly like a normal return.

So the log answers, for any trip: which drafts existed, which hop dropped which partial and why, and what the guard finally handed back.

## Implementation notes to confirm

- A guard trip arrives in two shapes — a thrown `GuardExceededError` from the runner, and a cancelled leaf op carrying a `guardTrip` cause. Both are exceptions only within one frame's extent: that frame's catch converts either into an AbortedResult. The trip's `cause` object rides the value BY IDENTITY, so the `delivered` de-dup flag keeps working across both delivery paths.
- `__tryCall` keeps a thin exception backstop: a trip thrown from runtime code between the guard and the block (e.g. the subprocess adapter) reaches the guard without a compiled frame to convert it. Backstop trips carry no partial; the value path is the salvage path.
- The post-call aborted check rides the SAME emission point as the interrupt check (`assignmentInterruptGuard`), so the two propagation systems cover exactly the same call sites by construction. If a site were missing, interrupts would already be broken there.
- Node level is the ceiling: a node that receives an aborted value rebuilds the exception (`toError`), so the graph engine, the CLI entry, REPL handling, and root budgets (#550) see aborts exactly as before. Root-budget trips never become values.
- The `savedDraft` slot on the frame joins `State.toJSON`/`fromJSON` so it survives interrupt/resume. AbortedResults themselves never serialize: they propagate to a guard or a node within one turn.
- Aborts do not cross the subprocess IPC boundary as live objects, so a child process's drafts die with the child. Same as #551; unchanged.
- Known shared envelope with interrupts: an aborted value flowing through a binOp operand (`g() + 1`) or into a non-`__call` JS interop path degrades the same way an Interrupt[] would today. Both systems share the fix whenever one lands.

## Deferred, with homes

- **Fork-array salvage:** each branch's partial collected into the fork's `T[]` shape, feeding the enclosing finalize. Needs the branch-boundary carried-draft handling above as its seam.
- **Finalize shielding + grace budget:** detach the tripped guard's signal around the finalize and arm a small fresh `TimeGuard` — the SIGTERM-handler pattern. Punted from v1 for complexity.
- **Root budgets:** a `--max-cost`/`--max-time` trip escapes to the compiled entry's catch carrying the carried draft, so `reportBudgetExceededAndExit` could print the best-so-far before exiting 3. Cheap once this lands; out of scope now.
- **Resumable guards (trips as interrupts):** fully designed in `2026-07-15-resumable-guards-design.md` — a handler can approve a trip with fresh budget allowances and an injected feedback message, or reject it, which delivers the abort at the paused point and runs THIS spec's machinery unchanged. Ships after this spec's PRs.
- `sigint`/`sigkill`, `saveDraft` as an LLM tool, a `Both` result type, and generalizing beyond guard trips (Esc, cancel, race-loss — the rung is cause-agnostic, so this is a policy check on `readCause`): unchanged from the original spec.
