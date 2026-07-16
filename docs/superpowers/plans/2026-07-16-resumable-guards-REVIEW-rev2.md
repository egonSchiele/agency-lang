# Plan review: resumable guards, rev 2 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 2)
**Supersedes:** `2026-07-16-resumable-guards-REVIEW.md` (rev 1 review)
**Verdict:** Much stronger. Every rev-1 blocker is genuinely resolved — not
papered over — and the PR restructure is the right call. One new blocker: the
handler-scoping coordinate (`guardDepth`) is not resume-stable, and the plan's
argument that it needs no checkpoint treatment is unsound. Two more findings are
worth settling before execution. Fix finding 1 and this is executable.

All line references are `packages/agency-lang/`.

---

## Rev-1 blockers: all resolved

Recording this so the next reader does not re-litigate:

- **Handler budget (rev-1 finding 1)** → decision 5 + Task 1.3. The
  registration-site rule is a better answer than the three options I sketched,
  because it generalizes to every effect instead of special-casing `std::guard`.
- **Aborted-stack handler chain (finding 2)** → PR 3's re-arm-before-dispatch,
  with `guard.ts:356`/`:453` correctly identified as why the checkpoint-resume
  precedent does not transfer.
- **Root marker (finding 3)** → decision 11 + Task 2.1, checked at both the raise
  site and the approve application. Both checks are needed; good.
- **Wrong raise site (finding 4)** → Task 2.2 now raises at `prompt.ts:554`/`:699`.
  The pre-call-gate framing ("raises *instead of* issuing the request — the
  pending window is zero by construction") is exactly right and is the detail
  that makes PR 2 sound.
- **Negative-as-disarm (finding 6)** → decision 4, explicit key + clamp-and-warn.
- **stdlib migration (finding 7)** → Task 2.5 audit-first.
- **Frame-keyed trip id (finding 8)** → `stack.other`.

---

## Blocking finding

### 1. `guardDepth` joins a replayed structure to a restored one, so it cannot be resume-stable.

Task 1.3 argues: "Handler stacks are not serialized (rebuilt by deterministic
replay on resume), so `guardDepth` needs no checkpoint treatment — but add a
resume-cycle test pinning that replayed registrations record the same depths."

The premise is true and the inference does not follow. The handler stack is
rebuilt by replay; the **guard array is not** — it is restored wholesale from
JSON (`stateStack.ts:883`, `stateStack.guards = (json.guards ?? []).map(guardFromJSON)`).
`guardDepth` is a coordinate joining the two. Only one side is replayed, so its
value cannot be assumed to survive a resume — and the concrete sequence says it
does not:

1. Original run: `handle` registers at guard depth 1. The guard installs. Depth
   becomes 2. The trip raises and checkpoints.
2. Resume: the stack is restored with **both** guards already in
   `stack.guards` (the checkpoint was taken at the trip, so the tripped guard is
   in the snapshot).
3. Replay re-enters the handle block, `withPushedHandler` (`asyncContext.ts:148`)
   calls `pushHandler` again — now recording `guardDepth = 2`.
4. The rule "suspend guards deeper than `entry.guardDepth`" now suspends
   nothing. The tripped guard is live for the handler's own `reviewerAgent`
   call, which hits `enforceGuards` (`prompt.ts:554`) and throws.

That is rev-1 finding 1 reappearing after any resume — i.e. after any real
check-in, which is the feature's whole use case.

Fork makes it worse. `fromJSON` leaves a branch with
`guards.length < inheritedGuardCount` until `runBatch` re-prepends the parent's
live references (the comment at `stateStack.ts:875-882` says so explicitly), so
during resume the indices are transiently meaningless, and after rehydrate every
branch-owned guard's index has shifted by the inherited count.

**The mirrored coordinate in Task 2.2 is the dangerous one.** "Eligible handlers
are those registered before the guard installed (the guard records the
handler-stack depth at install)" — that depth lives on the **guard**, which *is*
serialized. So it survives a checkpoint verbatim and is then compared against a
handler stack rebuilt by replay whose length at that moment need not match. If
the stored depth is too high, handlers registered outside the guard are skipped
and the trip escapes to the user endpoint with a live handler sitting right
there. Per CLAUDE.md that is not a bug tier we accept — a handler that must never
be skipped, silently skipped. The plan's "serialized consideration: none" is
wrong for this coordinate.

**This exact lesson is already in this workstream.** #551's `draftRegionStart`
tried to use `stack.stack.length` as a region coordinate and broke on resume for
the same reason (the restored frame shifted the length by one). The fix that
worked was: capture identity, memoize it in serialized branch-local state
(`stack.other`), first-write-wins so replay cannot recompute a different answer.

**Recommendation.** Make the coordinate identity-based and derive both directions
from it. One entry per handler: the set of `guardId`s live at registration. Then

- handler `i` may see guard `g`'s trip ⟺ `g.guardId ∉ entry_i.liveGuardIds`
- guards suspended during handler `i` = those whose id is not in
  `entry_i.liveGuardIds`

One rule, one direction, no second coordinate on the guard, and ids are stable
across resume and fork by construction (that is why `guardId` is serialized —
`guard.ts:94-97` — and why time clones carry the parent's id). It still needs the
memoize-in-`stack.other` treatment so a replayed registration cannot capture a
post-restore id set; that is the part to design before execution, not to pin with
a test afterward. As written, Task 1.3's test would be asserting a property the
code does not have.

Two smaller notes on the same task:

- `pushHandler(fn)` (`context.ts:532`) has no access to a `StateStack` —
  `ctx.handlers` lives on the context, the guards live on the ALS-resolved
  per-branch stack. Capturing the id set inside `pushHandler` means reaching
  through ALS into another object's fields from the context — the cross-object
  field-reaching pattern the owner flagged as the main issue on #553. Capture in
  `withPushedHandler` (`asyncContext.ts:143`) and pass it in.
- The `suspended` flag must be **excluded** from `GuardJSON` while `disarmed`
  (decision 4) must be **included**. Adjacent fields, opposite rules, and the
  fail directions differ: a handler that propagates gets checkpointed mid-
  suspension, and if `suspended` rides the snapshot the guard resumes
  permanently unmetered. Worth an explicit line in Task 2.1 and a fixture
  (handler propagates → user answers → resumed run still meters).

---

## Substantive findings

### 2. Concurrent branch trips on a shared cost guard over-grant, and the merge table does not cover it.

Decision 7 merges approvals **within one interrupt's handler chain**. It does not
merge across concurrent interrupts, and fork case 1 says each branch raises its
own.

Three branches under a shared `CostGuard` (`cloneForBranch` returns `this`,
`guard.ts:210`) all cross the limit at their next charge boundary and all raise.
The handler answers `approve({maxCost: 0.50})` three times — once per interrupt,
each honestly believing it granted fifty cents. The guard's limit rises by
$1.50. Nothing in the plan bounds this, and the natural handler (approve a fixed
top-up per trip) hits it immediately.

Fork case 1's fixture ("after branch A's approve, branch B's raised trip
re-checks its guard on resume; if the shared guard is no longer over budget, B
resumes cleanly when answered") describes B *re-checking* but still says B raised
and B gets answered — so B's approve still applies. The fix is to make the trip
per-guard rather than per-branch: while an unanswered trip exists for a
`guardId`, further branches detecting the same guard over budget attach to the
pending trip instead of raising their own, and on answer they all re-check. This
belongs in PR 2 with a fixture, and it interacts with decision 10's livelock
error (a re-checking branch that is still over budget must not be treated as a
handler that answered badly).

### 3. The merge table's registration surface is v1 scope that costs more than it buys.

Three problems, all with the same fix.

- **Module-global state.** A runtime table `effect → merge` in a new
  `effectMerge.ts` is per-run state in a TS module global — the standing rule
  says never (use the per-execution context/GlobalStore). Two runs in one process
  (the test suite) would share it; module isolation would leak.
- **Cross-process divergence.** "The cross-process merge routes through the same
  table" assumes both processes registered the same merges. A subprocess runs an
  arbitrary program (`stdlib/agency.agency`'s `run()` compiles whatever it is
  handed). If the child registered `std::guard`'s merge and the parent's program
  did not, `mergeChainOutcomes` in the parent silently falls back to
  outer-overwrites — the same interrupt merged one way in-process and another
  across IPC. Silent, and exactly the kind of thing that surfaces as a
  nondeterministic budget six months later.
- **Serialization.** A user-registered merge is user code (an Agency closure)
  consulted during the handler chain. Function refs across checkpoints are the
  `FunctionRefReviver` problem that produced #513 and #544; a registry of them
  consulted at adjudication time inherits that whole surface.

None of this is needed for what v1 ships. The only effect that needs a merge is
`std::guard`, and its merge is a constant. **Cut `defineInterruptMerge` and the
`std::effects` module from v1.** Ship `effectMerge.ts` as a built-in lookup —
`std::guard` → additive, everything else → today's overwrite. That kills all
three problems, and the registration surface can arrive with the typed-payloads
work (#555), which is where the shape will actually be informed.

### 4. Time-clone approve is erased at the join.

PR 3 + fork case 2: a branch's time clone trips, the handler approves
`{maxTime: 5m}`, and Task 2.3 resolves the guard from the raising branch's own
stack — so the **clone** is extended, correctly. The branch then runs its five
minutes and joins.

At the join, `runBatch` advances the parent by the max clone working time
(`guard.ts:404` `addElapsed`, and the `cloneForBranch` docstring at `:409-424`).
The parent's own `timeLimit` was never extended — the approve went to the clone —
so the parent's guard is now over budget by roughly the granted amount and trips
at the next boundary, with no work done in between. The user approved five more
minutes and got a trip anyway.

Not obviously wrong (the approve was branch-local), but it is surprising enough
that it needs an owner decision, not an executor's guess: does an approve on a
clone also extend the parent by the same delta (the parent is the budget the user
named), or is it branch-local and the join-trip is correct? Either way it wants
the fixture — fork, time clone trips, approve, join — because today the plan
would ship whichever behavior falls out.

---

## Smaller notes

- `costLimit` and `timeLimit` are `readonly` (`guard.ts:165`, `:317`) and are
  read by `toJSON` and `cloneForBranch`. `extendBudget`'s `limit += delta` needs
  them mutable; trivial, but `cloneForBranch` computing `remaining` from a
  mutated `timeLimit` is the interaction to keep an eye on for finding 4.
- Decision 10's livelock check is stated for "the tripped dimension over budget
  and armed." For cost that is `spent > costLimit`; for time the equivalent is
  `currentElapsed() >= timeLimit` — worth naming both, since `TimeGuard`'s trip
  is latch-based (`tripped`/`consumed`) and re-arming with a negative remaining
  gives `setTimeout(…, 0)`, i.e. a re-trip rather than a clean error.
- Task 2.2's "eligible handlers are those registered before the guard installed"
  and decision 5's "a handler registered inside a guarded block cannot see that
  guard's own trip" are the same rule stated from opposite ends. Say it once,
  derive both, per finding 1.
- **Estimate.** PR 1's 2–3 days assumes `guardDepth` is a small change. Making
  the coordinate resume-stable — plus the full existing handler suite green
  before new behavior — is more like 4–5. PR 2's 4–5 is right if finding 2 lands
  there. PR 3's 2–3 is honest about the recomposition.

## What is right

The PR restructure earns its keep: PR 1 is testable with ordinary interrupts and
would have been the hidden two-thirds of PR 2 otherwise. Raising at the pre-call
gate for a zero pending window, the explicit disarm key with clamp-and-warn, the
root marker checked at both sites, the audit-first migration, and the
`tripped`-vs-`consumed` distinction in Task 2.1 are all correct against the code.
The fork/race/IPC section remains sound apart from finding 2, which is new
scope from decision 2 rather than an error in the old analysis. Deferring the
`effect` syntax and typed payloads to #555 is the right cut.

## Recommended next steps

1. Redesign the scoping coordinate as identity + memoized capture (finding 1),
   and re-specify Tasks 1.3 and 2.2 around the single derived rule. This is the
   only thing blocking execution.
2. Owner decides finding 4 (does a clone approve extend the parent?).
3. Add the shared-guard trip dedupe to PR 2 (finding 2).
4. Cut `defineInterruptMerge` from v1; ship the built-in table (finding 3).
5. Re-estimate PR 1.
6. Work through the anti-pattern audit below — finding A3 is a correctness gap,
   not just a style one.

---

# Addendum: audit against `docs/dev/anti-patterns.md`

**Short answer to "is the plan writing declarative interfaces that encapsulate
complexity?": not yet.** The instinct shows up twice — "factor the raise dance
into a shared helper" (Task 2.2) and "this needs a dedicated helper" (PR 3) — but
everywhere else the plan specifies the *how* at each call site rather than naming
a *what* and hiding the how behind it. Five places, below, with the declarative
alternative for each. A2 and A3 are the ones that pay for themselves immediately:
each one deletes a bug I filed above rather than merely tidying it.

The bar here is not abstract. `guard.ts:20-59` already states the contract the
plan should be extending: *"`StateStack` and `Runner` only ever talk to the
interface — no `instanceof` checks, no variant-specific branching."* Three of the
findings below are the plan quietly breaking that promise.

### A1. Suspension is specified as three call-site edits. (*Imperative code everywhere*, *Leaky abstractions*)

Task 1.3: guards deeper than the handler's registration are "skipped by
`enforceGuards`, excluded from charge accumulation, and their time clocks
paused." That teaches three separate places what suspension means, and adds a
`continue`-if-suspended to `enforceGuards` (`stateStack.ts:569`) — a filter at
the call site standing in for a property of the guard.

Declarative version: suspension is a **guard lifecycle state**, which is exactly
what the existing interface already models (`install`/`uninstall`/`pause`/`resume`
/`charge`/`check`). Add `suspend()` / `unsuspend()` to the `Guard` interface. A
suspended guard's `check()` returns null and its `charge()` no-ops; `TimeGuard`'s
`suspend()` is `pause()`. **`enforceGuards` and the charge path then do not
change at all**, and the per-variant differences stay inside the variant, per the
interface's own contract.

The selection ("which guards does this handler suspend") is a second *what*, and
it wants its own name too — one function, `stack.guardsHiddenFrom(entry)` or
similar, that finding 1's identity rule lives inside. The plan currently states
that rule in prose in two tasks (1.3 and 2.2) from opposite ends, which is how it
ended up as two mirrored coordinates that have to be kept consistent by hand —
the *Leaky abstractions* entry almost verbatim: understanding one requires
reading the other.

### A2. `previousSignal` is order-dependent mutable state, and PR 3 is entirely a symptom of it. (*Order-dependent mutable state*)

This is the highest-leverage item in the audit.

Today the composed abort signal is **accumulated by mutation**: each
`installAbortPlumbing` saves `previousSignal = stack.abortSignal` and overwrites
`stack.abortSignal` with `AbortSignal.any([previous, mine])` (`guard.ts:451-460`);
`uninstall` restores it. The chain of who-composed-what lives implicitly in
per-guard fields, in install order.

Every hard thing in PR 3 falls out of that choice. "In-place re-arm must restore
`previousSignal` first, then re-compose"; "with nested time guards the
composition is a chain, so every composition above the tripped guard rebuilds";
"this needs a dedicated helper plus a fixture." And the bug I filed in the rev-1
review — a naive re-install captures the already-aborted composed signal as
`previousSignal` and poisons the stack permanently — is precisely the failure
mode the anti-patterns entry predicts: *"Reordering lines breaks things
silently."*

Declarative version: **derive the signal instead of accumulating it.** The stack
composes `abortSignal` on demand from its own base signal plus the live
controllers of its armed guards — one function, `stack.recomputeAbortSignal()`,
called when the guard array or any guard's armed state changes. `previousSignal`
is deleted outright. `install`/`uninstall` stop mutating `stack.abortSignal`.
Re-arm after an approve becomes "the guard is armed again; recompute" — no
restore-then-recompose ordering, no chain rebuild, nothing above the tripped
guard to touch, because there is no accumulated chain to repair. The nested-guard
fixture still earns its place, but as a regression pin rather than the thing
holding the design together.

This is worth doing even though it touches shipped code. It converts PR 3's
"genuinely fiddly" from a property of the task into a property of the old
representation, and it removes a foot-gun that will otherwise be re-discovered by
whoever adds the third guard variant.

### A3. One Agency guard is two runtime guards, and the interrupt shape hides it. (*Leaky abstractions* — and a correctness gap)

`_pushGuard` returns `string[]`, not a string (`lib/stdlib/thread.ts:263-291`).
`guard(cost: $1, time: 5m)` pushes a **`CostGuard` and a `TimeGuard` — two
objects, two `guardId`s** — with the label copied onto both. That is why
`__tryCall` matches on `ownedGuardIds` (plural) and why `_popGuard` takes an id
array.

The plan's model does not survive contact with that:

- `data.guardId` is a single id, so it names **one** of the pair.
- `approve({maxCost: 0.5, maxTime: 60000})` names both dimensions, but Task 2.3
  resolves *one* guard by that id and applies "additive extends per payload
  dimension." The sibling guard's id is not in the interrupt data at all, so the
  other dimension has nothing to apply to.
- `disarm: ["cost", "time"]` has the same problem.
- The interrupt data's `maxCost`/`maxTime` "for context" cannot both be filled
  from the resolved guard — it only knows its own limit.
- Decision 3 ("an omitted dimension continues unchanged") reads as a statement
  about one object's two dimensions. There is no such object; the two dimensions
  are independent guards that already continue independently.

The fix is the abstraction the runtime is missing rather than a patch: the id
array from `_pushGuard` **is** the Agency-level guard, and nothing names it
today. Introduce that name — a `GuardScope` over the pushed ids, with
`extend(payload)`, `disarm(dimensions)`, `snapshot()` (label, configured budgets,
spent, which dimension tripped), and a single resolver that takes the raising
branch's `StateStack` plus the scope identity. Then:

- the interrupt carries the scope, `dimension` says which member tripped;
- Task 2.3's approve application is `scope.extend(mergedPayload)` — one call, no
  `stack.guards` walk, no innermost-match rule at the call site;
- the fork/IPC rules the plan repeats in prose across four places ("resolve from
  the raising branch's own stack, never a global lookup") become one property of
  one resolver, tested once;
- the root-marker check (decision 11) has one place to live.

This also removes the last reason for PR 2 and PR 3 to touch `stack.guards`
directly, which is what keeps `guard.ts`'s no-variant-branching contract intact.

### A4. The merge arm is a three-way state machine over mutable flags. (*Useless special cases*, *Imperative code everywhere*)

Task 1.2 specifies: "no prior approval → hold the value; prior approval + merge
registered → `held = merge(held, next)`; prior approval + no merge → overwrite."
That is three branches plus the loop's existing `hasApproval` / `approvedValue`
mutable pair (`interrupts.ts:282-287`, `:295-297`) — and the third branch is the
*Useless special cases* entry: "no merge registered" is only special because the
table is partial.

Declarative version: make the table total (default merge = `(inner, outer) =>
outer`, which **is** today's overwrite), collect the approvals as the chain
walks, and render the outcome once:

```ts
const merge = mergeFor(effect);          // total; default is outer-wins
const approval = approvals.reduce(merge); // empty → none; one → itself
```

No special case, no `hasApproval` flag, no "hold" state, and "innermost-first" is
expressed by the order of the array rather than by prose about argument
positions. `mergeChainOutcomes`'s double-approve arm calls the same `mergeFor`,
so the cross-process path is the same code rather than a parallel one that has to
be kept in sync (*Inconsistent patterns*). This composes with rev-2 finding 3: if
the table is built-in and total, the module-global registry problem disappears
along with the special case.

### A5. Two spellings of one verdict. (*Inconsistent patterns*)

Task 1.1 keeps `undefined` working and adds `pass()` — reasonable for
back-compat, but the chain loop then handles one concept two ways forever.
Normalize at the boundary: the moment a handler returns, map `undefined` → `pass`
once, and let everything downstream (the loop, `handlerDecision`, the statelog
variant) see a single shape. One line, and the back-compat story stops leaking
into the adjudication logic.

### What the plan already does right

Reuse is good throughout: the `agency.interrupt` dance, the reply-attachments
pattern for PR 4, `pause()`/`resume()` for the clock freeze, and the existing
generic statelog events (decision 13) instead of new bespoke ones. No duplicated
utilities, no dynamic imports, no magic numbers. The problem is narrower than
"the plan is imperative": it names helpers where it noticed friction, and
specifies call-site edits everywhere it did not. A2 and A3 are where that costs
real correctness.

---

# Addendum 2: the test plan

Two questions: would these tests fail if the code broke, and what is missing?
**Five of the listed tests would pass with a bug I have already filed still
live**, and the single most important path in the feature — approve after a real
checkpoint and resume — has no test at all.

## Tests that would not fail when the code breaks

### T1. The shared-guard fixture cannot see the over-grant.

Fork case 1's fixture: "after branch A's approve, branch B's own raised trip
re-checks its guard on resume; if the shared guard is no longer over budget, B
resumes cleanly when answered." Every assertion there is about B *not hanging*.
The over-grant in finding 2 — three branches, three approves of $0.50, limit
rises $1.50 — satisfies this fixture perfectly. Assert the **resulting limit**
observably: after the approves settle, a spend that fits one grant but not three
must trip.

### T2. "Double-approve accumulates via merge" passes when merge is broken.

Merge gives +$1.00, today's overwrite gives +$0.50, and **both let execution
continue**. If the fixture asserts "the block finished", it passes with the merge
silently degraded to overwrite — i.e. it pins nothing. It has to spend into the
gap: after two `approve({maxCost: 0.50})`, a further $0.75 of spend must *not*
trip. Same for the cross-process merge-parity unit test.

### T3. The resume-cycle test asserts an implementation detail, not the behavior.

Task 1.3: "add a resume-cycle test pinning that replayed registrations record the
same depths." Two problems. If finding 1 is fixed by moving to identity, "the
same depths" no longer means anything and the test is dead weight. If depth
stays, the same depths are exactly what does *not* hold — so the plan lists as a
pin a test whose job is to fail.

Assert the behavior instead, which is implementation-independent: trip →
propagate → resume → the handler runs → its own `llm()` is not metered by, and
not blocked by, the tripped guard. That test catches finding 1 whatever the
coordinate ends up being.

### T4. The suspension fixture uses an untripped guard, so it covers two of three surfaces.

Task 1.3's fixture is "an ordinary interrupt raised inside `guard(cost:)`" — a
guard that has *not* tripped. But suspension has three surfaces (the task says
so): the `enforceGuards` gate, charge accumulation, and the clocks. The pre-call
gate (`prompt.ts:554`) only refuses when the guard is **already over budget**, so
an untripped guard cannot exercise it. A suspension that correctly skips charging
but forgets the gate passes this fixture and then fails on the first real trip —
which is the only situation the feature exists for.

Needs the tripped variant: guard trips → handler's own `llm()` runs to
completion.

### T5. The negative-clamp fixture asserts the warning, not the safety property.

"Negative-clamp warning" — the risk decision 4 exists to prevent is *fail-open*:
metering silently disappearing. A fixture that asserts a warning was printed does
not assert that the guard still meters. Assert the trip: after a clamped negative
approve, the guard must still trip on the next overspend. The warning is the
nice-to-have; the trip is the point.

## Missing tests

### M1. Nothing exercises approve across a real checkpoint. (The headline use case.)

Every approve fixture in Task 2.5 uses an in-program `handle` block. Those answer
via `interruptWithHandlers` **before** `runner.halt` is ever called
(`agencyInterrupt.ts:168` vs `:203`) — no halt, no checkpoint, no serialize, no
restore. So the entire resume path is exercised by exactly one fixture,
`unhandled-halts`, which halts and never comes back.

That means: the "check-in" story from the spec (run five minutes, look, grant
more) has no test; `stack.other`'s trip-id resume idempotency (Task 2.2) has no
test; finding 1 has no test; and every guard-state mutation is only ever tested
against a live in-memory guard, never a `guardFromJSON` one.

The harness already supports it — `{"action": "resolve", "resolvedValue":
{"maxCost": 0.5}}` maps to `approve(value)` (`lib/templates/cli/evaluate.ts:47`;
note the action name for a *valued* approve is `resolve`, not `approve`, which is
worth telling the executor). Add at minimum: trip with no in-program handler →
harness approves with a payload → block resumes → later trip still fires. That
one fixture covers more of the risk than half the current list.

### M2. The root marker has zero tests, and it is the hard safety property.

Decision 11 and Task 2.1 build the marker; the fixture list never mentions it.
Needs three: an approve naming a root guard's id is refused; a root trip still
throws rather than raising (the `--max-cost` spawn path, exit 3); and
`isRootBudget` survives a `toJSON`/`fromJSON` round trip. The third matters
because the marker is new serialized state, and if it drops on resume, root
budgets become approvable — silently, and only after a checkpoint.

### M3. Rev 2 dropped rev 1's mutator unit tests.

Task 2.1 lists `guard.test.ts` under Files and then enumerates no tests. Rev 1
had them: extend-then-check passes under the new limit; disarm survives a
`toJSON`/`fromJSON` round trip; the time extend resets the latch. That last one is
exactly the `consumed`-not-reset fail-open the task's own text calls out — the
plan describes the bug and deletes the test for it. Restore the list and add
`isRootBudget` + `disarmed` round trips.

### M4. `suspended` must not serialize — no test.

Per the addendum-1 note: a handler that propagates gets checkpointed while guards
are suspended. Pin it: propagate from inside a handler → user answers → resume →
the guard still meters. Absent this, a `suspended` flag that leaks into
`GuardJSON` produces an unmetered run that no other test can see.

### M5. Approve naming both dimensions — the fixture that would have caught A3.

The list has "omitted-dimension-continues", which names one dimension. Nothing
names *both* (`approve({maxCost: …, maxTime: …})` on a `guard(cost:, time:)`).
That is precisely the case that breaks on the two-objects-two-ids gap in A3, and
it is the natural thing a user writes. Add it.

### M6. Others, briefly.

- **`pass()` has no tests at all** (Task 1.1). Its stated motivation is match-arm
  exhaustiveness, so it wants a typechecker test that a `match` over verdicts is
  exhaustive with `pass()` present; plus `undefined` still working (the
  back-compat claim); plus the statelog decision variant.
- **Time-clone approve → join** (finding 4): no fixture either way.
- **IPC payload fidelity** is listed as "verify", not as a test. Make it one:
  disarm arrays and float deltas across the boundary.
- **Unhandled under `--policy`**: Task 2.4 says policy answers headless runs but
  lists no fixture. Given decision 1 is a breaking change and `--policy` is half
  the documented migration path, it needs one. Same for an unhandled trip inside
  a subprocess child.

## Flakiness

Cost trips are deterministic (synthetic cost); time trips race. #556 already
carries six wall-clock fixtures (sleep 2000 vs 600ms) and the owner flagged the
flakiness. Two items in this plan add more of that kind, and one of them cannot
work as described:

- **"omitted-dimension-continues (cost+time guard: cost trips, approve cost, time
  later trips with its ORIGINAL remaining allowance)"** — asserting *original
  remaining allowance* against a wall clock is a race with itself. Either it gets
  a generous margin and stops discriminating (it would pass if the clock had been
  reset), or it gets a tight one and flakes. Assert the elapsed accounting as a
  unit test on the guard, or read it from statelog; keep the fixture to the
  coarse "the time guard still trips."
- **PR 3's time approve-resume** is the same shape. The `promptStart`/
  `promptCancelled` pairing assertion is good and deterministic; the timing part
  is not.

Rule of thumb worth writing into the plan: if a behavior can be expressed with a
cost guard, use a cost guard. Reserve wall-clock fixtures for things that are
irreducibly about time.

## One discipline for the migration

Task 2.5 says the guards sweep "doubles as the breaking-change acceptance test."
That is only true under a rule the plan does not state: **every migrated
fixture's expected output must be byte-identical after adding the
`handle … reject()` wrapper.** If an expected output changes, that is a semantic
regression to explain, not a diff to accept. Hand-migrating ~29 trip fixtures is
exactly where a fixture quietly starts passing for a different reason, and the
sweep is the only thing standing between this change and every shipped guard
behavior.

## What is good

`reject-runs-salvage (draft and finalize)` is the right regression surface for
#553/#556. `draftValue` matches the savedDraft, `inside-guard handler does not
see the trip`, `livelock runtime error`, and `propagate-discards-approvals` each
pin a specific decision rather than a vibe. Running the full existing
handler/interrupt suites unchanged *before* adding new behavior tests (PR 1
validation) is exactly right for a change to safety infrastructure, and the
race-loser fixture (case 4) is a genuinely non-obvious case to have caught.
