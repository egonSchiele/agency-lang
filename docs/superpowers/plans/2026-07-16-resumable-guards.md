# Resumable Guards Implementation Plan (rev 8)

> **Status:** updated 2026-07-16 after the rev-7 review
> (`2026-07-16-resumable-guards-REVIEW-rev7.md`), which verified the
> deadlock fix's concurrency and left two mechanical corrections, both
> folded: the detect→raise call sites LOOP until the stack is clear (a
> single check would leak one request past a newly-over outer guard —
> decision 16's "asks its own question" now has a where), and the
> pending-trip record's `try` starts on the line after the set (a throw
> in the gap would have leaked the record and re-opened the deadlock).
> Every decision is settled. EXECUTION-READY.

**All file paths are relative to `packages/agency-lang/`.**

---

# Part 1: Background — how things work today

You cannot follow this plan without four pieces of context. Each is short.

## 1.1 How a guard trips today

`guard(cost: $1, time: 5m) as { ... }` does NOT create one guard object. It
creates two: a `CostGuard` and a `TimeGuard`, each with its own `guardId`
(`lib/stdlib/thread.ts:263-291`, `_pushGuard` returns a `string[]` of ids).
Both are pushed onto the branch's `StateStack.guards` array. This plan calls
the pair a **guard scope**. The runtime has no name for it today; PR 2 gives
it one (`GuardScope`).

The two guards trip in different places:

- **Cost guards** trip wherever cost is charged, via `stack.enforceGuards()`
  (stateStack.ts:569), which walks the guards and throws
  `GuardExceededError` if any is over budget. It has FOUR callers, and this
  plan treats each one explicitly (Task 2.2): the pre-request gate in
  `runPrompt` (prompt.ts:554); the post-charge check after a completion
  (prompt.ts:699); `addCost` (`lib/runtime/cost.ts:12`), which is how paid
  TypeScript helpers charge cost outside of `llm()` — its docstring warns
  "callers must not swallow it"; and the subprocess telemetry handler
  (`lib/runtime/ipc.ts:897`), where a child's reported cost charges the
  parent's guards and a trip kills the child.
- **Time guards** trip from a timer. When the timer fires, the guard aborts
  an `AbortController`. That composed abort signal cancels whatever is in
  flight: an LLM request gets cancelled mid-generation, a `sleep()` wakes up
  early, and pure Agency code notices at its next step boundary (every
  compiled statement runs inside `runner.step(...)`, and step entry checks
  the signal via `shouldSkip`, `lib/runtime/runner.ts:315`).

## 1.2 How an interrupt is raised and answered today

`lib/runtime/agencyInterrupt.ts` documents the whole dance. Short version:

1. The raise site calls `interruptWithHandlers(effect, message, data, ...)`
   (`lib/runtime/interrupts.ts:422`).
2. That runs the **handler chain**: every handler on `ctx.handlers`, innermost
   first. Each handler returns `approve(value)`, `reject()`, `propagate()`,
   or nothing. Reject short-circuits. Approvals overwrite each other
   (outermost wins). Any propagate beats any approve.
3. If the chain settled it, the raise site gets the verdict directly. **No
   checkpoint happens in this case.** The handler chain runs to completion
   before the raise site moves — the paused code cannot race its own verdict.
4. If nobody settled it, the interrupt propagates outward: the run halts,
   a checkpoint serializes the branch, and the user (CLI prompt, `--policy`,
   or a TypeScript caller) answers. On resume, the program replays from the
   top with step counters skipping completed work, and the raise site returns
   the recorded answer instead of re-raising (resume idempotency, keyed by a
   persisted interrupt id).

One harness detail that matters for our fixtures: when a test's `test.json`
answers an interrupt with a value, the action is `"resolve"`, not
`"approve"` — `{"action": "resolve", "resolvedValue": {...}}` maps to
`approve(value)` (`lib/templates/cli/evaluate.ts:47`).

## 1.3 How handlers and guards relate at runtime

Handlers live on `ctx.handlers` (context-wide). Guards live on
`stack.guards` (branch-local). A handler body executes in the raising
branch's async context, so when the handler calls `llm()`, that call reads
the SAME stack — and today it is metered and gated by ALL installed guards,
including the one whose trip the handler is deciding. That is the bug class
decision 3 (below) fixes.

Two structural facts drive the design:

- **Handlers are replayed; guards are restored.** On resume, a handler
  whose `handle` block is still OPEN at checkpoint time is re-registered by
  re-executing its registration (handlers are functions; they cannot be
  serialized — CLAUDE.md calls them safety infrastructure). A handle block
  that already COMPLETED is skipped entirely, and correctly so — its scope
  is over. The proof is one line in the very function this plan edits:
  `Runner.handle` opens with `if (this.getCounter() > id) return;`
  (runner.ts:772) — a completed block returns BEFORE `pushHandler`. Guards
  are the opposite: they are restored wholesale from JSON before replay
  starts (`stateStack.ts:883`). Any rule that connects "a handler" to
  "some guards" must survive that asymmetry. Array indices and depth
  counters do not (rev-2 review). Counters of any kind do not — runner.ts:772
  is exactly why four counter designs died in review (decision 14). The
  design below uses guard IDENTITY (ids are serialized and stable) plus a
  memo whose key reproduces under replay.
- **`Runner.beforeStep` resumes every guard at every step entry**
  (runner.ts:265-267). Any "this guard is suspended" state must survive
  that, or the first step a handler body executes will un-suspend the
  tripped guard (rev-3 review finding 3).

## 1.4 What already shipped

The salvage pipeline (#553/#554/#556): an aborted scope returns an
`AbortedResult`; `saveDraft` and `finalize` produce the partial value a
tripping guard salvages. Nothing in this plan changes any of it. Reject means
"run that pipeline exactly as today." Guard labels shipped in #554. Message
debug labels are in flight separately (#557); PR 4 uses them.

---

# Part 2: The decisions

Every numbered decision here is owner-settled.

1. **Trips become ordinary interrupts (effect `std::guard`) — a breaking
   change.** An unhandled trip propagates like any interrupt: to the
   TypeScript caller, or to the user endpoint, or (headless, no policy) it
   halts with the standard unhandled-interrupt error. Code that wants
   today's "trip returns a failure" wraps the guard:
   `handle { ... } with (i) { return reject() }`, or answers `std::guard`
   via `--policy`.
2. **Approve is additive.** `approve({maxCost: 0.05})` on a guard that spent
   $1.00 of $1.00 makes the limit $1.05. Naming the other dimension adds to
   it too. An omitted dimension is untouched and keeps its remaining
   allowance.
3. **A handler's registration site decides everything about it.** One rule,
   two consequences. Each handler remembers *which guard ids were live when
   it was registered*. Consequence one: a handler can only see trips from
   guards NOT in that set (you cannot adjudicate a guard you are inside).
   Consequence two: while the handler runs, guards NOT in that set are
   suspended — they do not gate, meter, or charge the handler's own work.
   This applies to handlers of ALL interrupts, not just trips (also
   breaking, also accepted).
4. **Disarm is explicit:** `approve({disarm: ["cost"]})`. Negative deltas
   clamp to zero and warn. (Negative numbers still mean "disabled" at
   guard *construction* — there they just mean no guard is pushed,
   thread.ts:272-286 — but the approve channel does arithmetic, and
   arithmetic that accidentally goes negative must not silently remove
   metering.)
5. **`pass()` is a new verdict** meaning "not mine, ask the next handler."
   `undefined` still works and is normalized to `pass` at the boundary.
6. **Approvals merge through a built-in, total, per-effect table.**
   `std::guard` merges additively (sum grants, union disarm lists, join
   messages). Every other effect merges as `(inner, outer) => outer`, which
   is byte-for-byte today's behavior. There is NO user registration surface
   in v1 (it was cut: a runtime registry is banned module-global state, it
   diverges across subprocess boundaries, and user merge closures would sit
   on the FunctionRefReviver problem surface — #513/#544). Registration
   arrives with typed payloads (#555).
7. **Reject is absolute** (any reject rejects; short-circuits; no payload).
   **Propagate discards accumulated approvals** in v1.
8. **A useless approval is a runtime error.** If the merged answer leaves
   the tripped dimension still over budget and still armed, the run would
   re-trip forever (the handler-chain recursion guard cannot catch this;
   its depth counter resets on every fresh trip). The error is attributed to
   the answering handler. Per dimension: cost is over when
   `spent > costLimit`; time is over when elapsed working time ≥ `timeLimit`.
9. **Root budgets stay hard.** `--max-cost`/`--max-time` guards get a
   serialized `isRootBudget` flag (nothing marks them today —
   `rootBudget.ts:23,30`). Root trips never raise interrupts; they throw
   exactly as today (spawn path exits 3). An approve that reaches a root
   guard is refused.
10. **Concurrent trips of one shared cost guard dedupe.** Fork branches
    share one `CostGuard` object (`cloneForBranch` returns `this`,
    guard.ts:210). Without dedupe, three branches raise three interrupts, a
    handler grants $0.50 three times, and the limit silently rises $1.50.
    With dedupe: while a trip for a scope is unanswered, other branches that
    detect the same over-budget scope wait for that answer instead of
    raising their own, then re-check. This is **cost-only by construction**
    — time clones are separate objects with separate budgets, so there is
    nothing to dedupe.
11. **No `thread` in the interrupt data (v1).** Handlers that want the
    conversation use `listThreads()`/`getThread()`. `draftValue` (the
    guarded scope's `savedDraft` at raise time) IS included.
12. **Statelog: the generic interrupt events, unchanged.** They already
    carry `{effect, message, data}`. `pass()` adds one decision-variant
    string. Approve-payload validation is runtime-only in v1.
13. **Test disciplines** (from the rev-2 review, all adopted):
    - Assert budgets by SPENDING INTO THE GAP. "It didn't hang" and "it
      finished" pass under broken merges and over-grants. After two
      $0.50 grants, a further $0.75 spend must not trip; in the broken
      world it must.
    - If a behavior can be shown with a cost guard, use a cost guard.
      Wall-clock fixtures only for behavior that is irreducibly about time.
    - Every migrated fixture's expected output must be BYTE-IDENTICAL after
      its `handle`+`reject()` wrapper. Any diff is a semantic regression to
      explain, not to accept.
14. **Replay-stable keys are derived from POSITION or CONTENT — never from
    counting events.** This plan got it wrong three times in a row (a depth
    counter, a serialized counter, an in-memory counter, then a generation
    counter), and each failed the same way: resume does not re-run events,
    it re-runs the PATH to the checkpoint, skipping completed statements and
    completed loop iterations (docs/dev/interrupts.md — "statements with
    lower indices are skipped"; completed iterations skip via the
    `__currentIter` comparison). Any counter therefore counts different
    events on replay than it counted originally. The repo's two proven
    replay-stable key families: position (the callsite's `stepPath`, stored
    in the owning frame's locals — how `agency.interrupt` keys its
    persisted ids) and content (the identity of the thing itself — how #551
    keyed draft regions by `ids.join(",")`). Tasks 1.3b and 2.2 each use
    one of these and say why.
15. **The join rule (Part 3): Option A — the grant follows the budget.**
    When a fork branch's time-guard clone is extended by an approve, the
    parent guard is extended too, at the join. Mechanically: the parent is
    charged the working time of ONE branch (the longest, via `addElapsed`),
    so the parent's extension is THAT branch's granted delta — not the max
    delta across branches, which could come from a different branch than
    the time did. Each clone records its granted total in a serialized
    field; the join reads it from the branch whose elapsed time it charges.
16. **Grants never cross budgets.** The clone→parent extension in
    decision 15 is one budget syncing its instances — the clone IS the
    guard the user wrote, split by fork isolation. Distinct budgets stay
    independent: extending an inner guard never touches the guards that
    enclose it. If newly granted inner spend later pushes an OUTER guard
    over its limit, the outer guard trips on its own, raises its own
    interrupt, and is adjudicated by handlers registered outside IT —
    possibly a human. Three reasons this is the right shape: an enclosing
    guard is a containment promise, and auto-widening it from inside would
    make every ceiling meaningless; root budgets are ancestors, and
    decision 9 forbids extending them (an ancestor rule would need a root
    carve-out — one rule becoming two is the tell); and each budget's own
    decision point, with its own label and its own audience, is exactly
    what the interrupt machinery is for. The guards guide should show the
    resulting UX pattern: a handler that grants the inner budget may
    immediately face the outer guard's own trip, which reads as "I approved
    and it asked again" and is the system working.

---

# Part 3: The join rule (decided: Option A)

The story that forced the decision: you fork three branches under
`guard(time: 10m)`. Fork gives each branch its own clone of the time guard,
so one slow branch cannot eat the others' budget. Branch B's clone trips at
10 minutes. Your handler approves 5 more minutes. The approve extends **B's
clone** — that is the guard that raised, and resolution is branch-local by
design. B runs 5 more minutes and finishes.

Now the join. Today, `runBatch` charges the parent guard with the LONGEST
branch's working time (guard.ts:404, `addElapsed`). B worked 15 minutes. The
parent's limit is still 10. Without a rule, the parent is now 5 minutes over
budget and trips at the next step — even though you just approved those 5
minutes and the work is already done.

**Decided (Option A): the grant follows the budget.** The user approves
against the guard they wrote, not against a clone they never see; "I
approved and it tripped anyway, after the work succeeded" is the outcome
that needs a bug report to understand. Mechanics are in decision 15: the
parent extends by the granted delta OF THE BRANCH WHOSE TIME IT IS CHARGED
(the longest branch) — not the max delta across branches, which could come
from a different branch than the time did. Task 3.3 implements it.

**And the rule stops there (decision 16): grants never cross budgets.**
The parent extension is one budget syncing its fork instances. A NESTED
guard is a different budget, and extending an inner guard never widens the
guards around it — if the granted spend later pushes an outer guard over,
that guard trips on its own and asks its own question.

---

# Part 4: PR 1 — interrupt infrastructure

Everything in PR 1 works on ordinary interrupts. No guard raises anything
yet. This is deliberate: the handler machinery is safety infrastructure, and
we want its changes proven green against the whole existing interrupt suite
before guards start using it.

## Task 1.1: the `pass()` verdict

**Files:**
- `lib/runtime/interrupts.ts` (constructors at :34-38, chain loop at :264-292)
- `lib/runtime/index.ts` (export barrel)
- `lib/typeChecker/builtins.ts` (:276-294, next to `propagate`)
- `docs/site/guide/handlers.md`
- Tests: `lib/runtime/interrupts.test.ts` (or nearest existing chain test
  file), one typechecker test, one agency execution fixture.

**Runtime.** Add the constructor next to `approve`/`reject`:

```ts
/** Explicit "not my interrupt — ask the next handler." Identical in
 *  effect to returning nothing, but usable in value position (a match
 *  arm must produce a value). */
export function pass(): InterruptResponse {
  return { type: "pass" };
}
```

Normalize at the boundary so the rest of the chain sees ONE spelling.
In `runHandlerChain`, immediately after `result = await ctx.handlers[i](...)`:

```ts
// A handler that returns nothing means "pass". Normalize here so the
// loop, statelog, and merge logic never see two spellings of it.
if (result === undefined) {
  result = { type: "pass" };
}
```

Then the existing `if (result === undefined)` arm becomes
`if (result.type === "pass")`, emitting `handlerDecision` with
`decision: "pass"` and continuing. (`lib/statelogClient.ts`'s
`handlerDecision` takes the decision as a string; add the variant to its
type union if one exists.)

**Typechecker.** One entry in `lib/typeChecker/builtins.ts`, mirroring
`propagate` exactly:

```ts
pass: {
  params: [],
  returnType: ANY_T,
  description:
    "Inside a `handle ... with` block, decline to answer this interrupt and let the next handler decide.",
},
```

That is the whole typechecker change. `approve`/`reject`/`propagate` are
plain builtins returning `ANY_T`; handler return positions already typecheck
against that; `pass()` slots in identically. No new diagnostic, no new
checker pass. Verify the wiring end-to-end by grepping how `propagate`
reaches generated code (runtime export + builtin entry is expected to be
all of it) and mirror whatever you find.

**Tests.**
- Chain unit test: a handler returning `pass()` continues the chain; a
  handler returning `undefined` still continues the chain (back-compat pin);
  both emit `decision: "pass"`.
- Typechecker test: a handler whose body is a `match` on
  `intr.effect` with a `pass()` arm typechecks (this is the motivating
  case: exhaustiveness needs a value in every arm).
- Agency fixture: two nested handle blocks; inner passes, outer approves;
  the interrupt resolves approved.

## Task 1.2: the total merge table

**Files:**
- Create: `lib/runtime/effectMerge.ts`
- Modify: `lib/runtime/interrupts.ts` (`runHandlerChain` :264-298,
  `mergeChainOutcomes` :301-326)
- Tests: co-located unit tests + one agency fixture.

**The table.** A constant — not a mutable registry:

```ts
type ApprovalMerge = (inner: any, outer: any) => any;

/** How two approvals of the same interrupt combine. `inner` is the
 *  approval from the handler closer to the interrupt. Total: every
 *  effect has a merge; the default IS the historical behavior
 *  (outermost approval wins). Deliberately a constant — a runtime
 *  registration surface was cut from v1 (module-global state, silent
 *  cross-process divergence, function refs across checkpoints). */
const DEFAULT_MERGE: ApprovalMerge = (_inner, outer) => outer;

const MERGES: Record<string, ApprovalMerge> = {
  "std::guard": (a, b) => ({
    maxCost: sumOrUndefined(a?.maxCost, b?.maxCost),
    maxTime: sumOrUndefined(a?.maxTime, b?.maxTime),
    disarm: unionOrUndefined(a?.disarm, b?.disarm),
    message: joinOrUndefined(a?.message, b?.message, "\n"),
  }),
};

export function mergeFor(effect: string): ApprovalMerge {
  return MERGES[effect] ?? DEFAULT_MERGE;
}
```

(`sumOrUndefined(a, b)` returns `undefined` when both are undefined,
otherwise `(a ?? 0) + (b ?? 0)`; likewise the union and join helpers. Write
them in this file; they are three lines each.)

**The chain.** Replace the `hasApproval`/`approvedValue` mutable pair with
collect-then-reduce. In `runHandlerChain`, the approve arm becomes
`approvals.push(result.value)` (plus its existing statelog line), and the
final rendering becomes:

```ts
if (hasPropagation) return { kind: "propagated" };
if (approvals.length > 0) {
  const merge = mergeFor(interruptObj.effect);
  return { kind: "approved", value: approvals.reduce(merge) };
}
return { kind: "noResponse" };
```

`approvals` is in chain-walk order, which is innermost-first, so
`reduce(merge)` applies `merge(inner, outer)` in the documented order.

**Cross-process.** `mergeChainOutcomes(inner, outer)` currently resolves a
double-approve as `outer.value ?? innerValue`. Replace that arm with
`mergeFor(effect)(innerValue, outer.value)` — which requires threading the
effect into the function (it currently takes only the two outcomes; add the
parameter, update both call sites in `gatherChainOutcome`).

One pre-existing asymmetry to preserve, stated plainly because it means the
default merge is two functions, not one. In-process, an outer approve with
no value OVERWRITES an inner approve's value with undefined — that is
deliberate and documented in the chain. Across IPC, an outer valueless
approve DEFERS to the inner value, because JSON cannot distinguish "no
value" from "explicitly undefined." So: the in-process default merge is
`(inner, outer) => outer`; the IPC default merge is
`(inner, outer) => outer ?? inner`. `std::guard`'s additive merge is the
same function on both paths. Put both defaults in `effectMerge.ts` side by
side with this explanation as the comment.

**Tests.**
- Unit: `reduce` order (three approvals, non-commutative message join comes
  out inner-to-outer); default merge = overwrite, pinned against the
  existing chain tests running unchanged.
- Agency fixture, spend-shaped per decision 13: two nested handlers each
  `approve({maxCost: 0.50})` on a `std::guard` interrupt (PR 1 can raise one
  synthetically from a test helper, or this fixture waits for PR 2 — if it
  waits, pin the merge with a unit test now and add the fixture to PR 2's
  list). After both grants, a $0.75 spend must NOT trip. Under a merge
  silently degraded to overwrite, it must.

## Task 1.3: registration-site scoping

This is the safety-critical task. Read Part 1.3 first.

**Files:**
- Modify: `lib/runtime/runner.ts` (`Runner.handle` :766-785 — THE capture
  point; see 1.3a)
- Modify: `lib/runtime/state/context.ts` (handler entry shape, `pushHandler`
  :532)
- Modify: `lib/runtime/agency.ts` (:304, `agency.withHandler`) and
  `lib/runtime/agencyFunction.ts` (:267, `preapprove`) — the two TS-side
  registration paths
- Modify: `lib/ir/prettyPrint.ts` (:389, the `withHandler` TSIR node's
  inline emission for top-level init)
- Modify: `lib/runtime/state/stateStack.ts` (new method `guardsHiddenFrom`)
- Modify: `lib/runtime/guard.ts` (interface + both variants: `suspend()` /
  `unsuspend()`)
- Modify: `lib/runtime/interrupts.ts` (chain loop: suspend around each
  handler invocation)
- Tests listed at the end of the task.

### 1.3a: what each handler remembers, and WHERE it is captured

The handler entry grows from a bare function to:

```ts
type HandlerEntry = {
  fn: HandlerFn;
  /** guardIds live on the registering branch's stack at registration
   *  time. Decides which trips this handler may see, and which guards
   *  are suspended while it runs. See 1.3b for the memo. */
  liveGuardIds: string[];
};
```

`ctx.pushHandler` has THREE callers, and each gets an explicit rule —
the rev-5 review's blocker was anchoring the capture in a function
(`withPushedHandler`) that Agency `handle` blocks never call. The real
registration path for Agency code is:

```
handleBlock → processHandleBlockWithSteps (typescriptBuilder.ts:4020)
            → "await runner.handle(<id>, <handler>, ...)"
            → Runner.handle (runner.ts:766) → ctx.pushHandler (:778)
```

(`with` modifiers take the same path, :4055.)

1. **`Runner.handle` (runner.ts:778) — Agency `handle` blocks and `with`
   modifiers. The capture point.** It has everything the memo needs, with
   no ALS reach-through: `this.stack` (the branch's guards), `this.frame`
   (the per-frame store that makes recursion safe), `this.stepPath(id)`
   (the position key — already computed two lines up for coverage), and
   the existing `finally` (:783-785) for the delete-on-pop rule. The full
   sketch is in 1.3b.
2. **`agency.withHandler` (agency.ts:304) — the public TS API** (and
   `withPushedHandler`, which serves it). Captures the live ids from its
   ALS stack at call time, with NO memo: TS callers sit outside the
   replay machinery and own their own re-execution semantics. Document
   that at the API.
3. **`preapprove()` (agencyFunction.ts:267) and the top-level-init
   `withHandler` TSIR emission (prettyPrint.ts:389).** Both register
   handlers with `liveGuardIds: []`. Empty is NOT a neutral default —
   `guardsHiddenFrom` reads it as "hide every guard" — so it is a stated
   decision, not an accident: the init wrapper registers before any guard
   can exist (correct), and preapprove's body never spends (see next
   paragraph).

**`preapprove()` must `pass()` on `std::guard`.** Its handler answers
every interrupt with `approve()` — which for a guard trip is
`approve({})`, and decision 8 makes that a runtime error. Auto-approving
work is meaningful; auto-granting budget is not. The preapprove wrapper
gains one line: `if (intr.effect === "std::guard") return pass();`. Pin it
with a fixture (a preapproved tool trips a guard: the trip propagates
outward instead of erroring inside the wrapper).

### 1.3b: why there is a memo, and what its key is

The trap (rev-2, rev-3, AND rev-4 reviews — and the #551 `draftRegionStart`
bug before all of them): on resume, `stack.guards` is restored from JSON
BEFORE replay re-runs the `withPushedHandler` calls. So a replayed capture
sees guards that did not exist when the handler originally registered —
including the tripped guard itself. The replayed handler would then "know
about" the tripped guard, suspend nothing, and the whole feature silently
breaks after any resume (which is the feature's main use case).

Fix: capture is MEMOIZED, first-write-wins. The original run writes the
true set; a replayed registration finds the memo and uses it; the
post-restore recomputation never wins.

The memo key must reproduce under replay, and decision 14 is the law here:
**position or content, never an event count.** Four counting keys have now
failed review in a row, each for the same reason — replay does not re-run
events, it re-runs the path to the checkpoint, SKIPPING completed
statements and completed loop iterations. Concretely, the counter version
dies with no loop at all: two sequential handle blocks; the first completes
and is skipped on resume; the second — ordinal 1 in the original run — is
the FIRST registration the replay executes, asks for ordinal 0, and
memo-hits the first block's stale set. The tripped guard is not in that
set, so it gets suspended for a handler that sits inside it. Fail-open.

The design that works is the one `agency.interrupt` already uses for its
persisted ids (`agencyInterrupt.ts:152`): **key by position — the
registering callsite's `stepPath` — and store in the registering frame's
`locals`** (which serialize with the stack). Plus one cleanup rule that
makes loops safe. In `Runner.handle` (runner.ts:778), where everything
needed is already a field on `this`:

```ts
// In Runner.handle, replacing the bare pushHandler at :778:
const memoKey = `__handlerGuards_${this.stepPath(id)}`;
let liveGuardIds = this.frame.locals[memoKey] as string[] | undefined;
if (liveGuardIds === undefined) {
  liveGuardIds = this.stack.guards.map((g) => g.guardId); // first write wins
  this.frame.locals[memoKey] = liveGuardIds;
}
this.ctx.pushHandler(handlerFn, liveGuardIds);
this.path.push(id);
try {
  await this.runInScope(() => callback(this));
} finally {
  this.path.pop();
  this.ctx.popHandler();                    // existing finally, :783-785
  delete this.frame.locals[memoKey];        // the cleanup rule — see below
}
```

And one line above all of this, already in the function, is decision 14's
proof: `if (this.getCounter() > id) return;` (runner.ts:772) — a completed
handle block returns before registering anything on replay. That line is
what killed every counter design.

Why each hard case is safe:

- **Sequential handle blocks:** different callsites, different `stepPath`s,
  different keys. No collision, skipped-or-not.
- **A handle block inside a loop:** every iteration registers from the SAME
  callsite — which is why a bare callsite key failed rev-3 review
  (first-write-wins would hand iteration 2 iteration 1's stale set, and
  since `nextGuardId()` mints fresh ids per push, iteration 2's own guard
  would be missing from it — fail-open). The cleanup rule fixes it: the
  memo entry is deleted when the registration POPS, so at most one live
  registration per callsite holds an entry at any time, and it is always
  its own. A resume lands inside some iteration; that iteration's entry
  was written and not yet deleted; the replayed registration memo-hits its
  own set. Completed iterations deleted their entries before completing.
- **Does the checkpoint see the entry before the dying process deletes
  it?** Yes, on two conditions, both stated so the executor verifies
  rather than assumes. Ordering: the checkpoint serializes at the raise,
  and the `finally` deletion in the abandoned process runs during the
  unwind AFTER the snapshot exists. And COPYING: `checkpoints.create` must
  snapshot `frame.locals` by value, not hold a live reference — an aliased
  snapshot would feel the delete exactly when the memo is needed. This is
  #551's lesson in reverse (there, the serialize path hid the bug; here it
  is the protection), so it is very likely already a deep copy. Verify it
  in one line before relying on it; the delete-on-pop rule rests on it.
- **Recursion** (the same handle block callsite in two live frames at
  once): `frame.locals` is per-frame, so each activation has its own
  entry. This is exactly why the store is frame locals and not
  `stack.other` — a branch-global map keyed by callsite would collide
  across recursive activations.
- **One registration per step body** is the constraint this inherits, the
  same one `agency.interrupt` documents for itself. The compiled handle
  block wrapper satisfies it by construction; assert it in a comment.

Do not test key values or ordinals — test the behavior (rev-2 review T3):
the resume test below fails under every broken key design we have tried,
whatever the key is.

### 1.3c: suspension is a guard state, not call-site filters

> **AS IMPLEMENTED (PR 1) — one deviation, found during execution.** An
> object-level `suspended` flag is WRONG for CostGuard: the object can be
> SHARED across fork branches (`cloneForBranch` returns `this`), so
> flagging it would drop sibling branches' charges and open their gates
> while one branch's handler deliberates — fail-open on the shared
> budget, in exactly the window a handler is thinking. Cost suspension is
> therefore STACK-scoped: `StateStack.suspendedGuardIds` (in-memory,
> branch-local, never serialized), consulted inside `enforceGuards` and
> `chargeGuards`, bracketed by `beginHandlerSuspension`/
> `endHandlerSuspension` (save/restore, so nested chains compose).
> `Guard.suspend()`/`unsuspend()` remain on the interface for the
> per-branch-object state: TimeGuard pauses its clock and pins `resume()`
> to a no-op (beforeStep resumes all guards every step); CostGuard's are
> deliberate no-ops with the explanation in place. PR 2's
> `scope.suspendAll()` at the raise site must use the SAME stack-scoped
> bracket, for the same reason: the raising branch's deliberation must
> not blind siblings sharing the guard.
>
> **Second execution note (PR 1 review round):** because CostGuard's
> object cannot decline its own `check()`, EVERY trip-detection walk
> must consult the stack's suspension set. `Runner.shouldSkip` had its
> own private `check()` walk that did not — a suspended over-budget
> cost guard would have thrown its trip out of the handler that
> suspended it whenever the abort signal was live (normal state in
> PR 2's deliberations). Fixed by collapsing both walks into ONE
> suspension-aware method: `StateStack.detectTrippedGuard():
> GuardExceededError | null` — which is ALSO the detection sibling
> Task 2.2 needs, already landed. PR 2's raising sites loop on it as
> planned; it returns the error (which carries the guardId) rather
> than the guard.

Add to the `Guard` interface (`guard.ts:20-59`) — and note that interface's
own contract: StateStack and Runner only ever talk to the interface, no
variant-specific branching at call sites. Suspension keeps that promise:

```ts
/** While suspended, a guard is invisible to enforcement: check()
 *  returns null, charge() is a no-op, and (TimeGuard) the working-time
 *  clock is paused. resume() DOES NOT clear suspension — Runner's
 *  beforeStep resumes every guard at every step entry (runner.ts:265),
 *  and a handler body executes steps; without this rule the first step
 *  of the handler would silently un-suspend the tripped guard and
 *  restart its clock. Only unsuspend() clears it.
 *  NEVER serialized: a handler that propagates gets checkpointed
 *  mid-suspension, and a suspended flag riding the snapshot would
 *  resume the run permanently unmetered. */
suspend(): void;
unsuspend(): void;
```

- `CostGuard`: `suspended` boolean; `check()` and `charge()` return early.
- `TimeGuard`: `suspend()` = pause the clock + set the flag; `resume(stack)`
  no-ops while the flag is set; `unsuspend()` clears the flag (the next
  `beforeStep` resume restarts the clock normally).
- `enforceGuards` (stateStack.ts:569) and the charge path DO NOT CHANGE.
- `toJSON`: `suspended` is excluded. (`disarmed`, decision 4, is included —
  adjacent flags, opposite rules, opposite fail directions. Say so in a
  comment on both.)

Selection is one named method on the stack:

```ts
/** The guards a given handler must not see or be metered by: every
 *  installed guard that was NOT live when the handler registered.
 *  Identity-based on guardId — ids are serialized and survive resume
 *  and fork (clones keep the parent's id), which array indices do not. */
guardsHiddenFrom(entry: HandlerEntry): Guard[] {
  return this.guards.filter((g) => !entry.liveGuardIds.includes(g.guardId));
}
```

**The cross-branch rule.** `ctx.handlers` is context-wide (context.ts:85)
while `liveGuardIds` are branch-local, so a handler registered inside fork
branch A is consulted for an interrupt raised in sibling branch B. That
visibility is pre-existing behavior; decision 3 gives it a defined meaning
rather than an arbitrary one, because `guardsHiddenFrom` always evaluates
against the RAISING branch's stack: guards that existed before the handler
registered (shared cost guards; inherited time clones, which keep the
parent's id) match the captured set and still meter the handler; anything
newer — including everything branch-local to the sibling — is hidden. Note
the main use case DEPENDS on cross-branch eligibility: the walked example's
handler registers before the fork, so branch trips must reach it. One
fixture pins the sibling case: a handler registered inside branch A,
answering an interrupt raised in branch B, is metered by the shared
pre-fork guard and not by B's local guards.

### 1.3d: the chain applies it

In `runHandlerChain`, around each handler invocation (the existing
`enterToolCall`/`exitToolCall` bracket at interrupts.ts:236-242 shows the
shape):

```ts
const hidden = stack ? stack.guardsHiddenFrom(entry) : [];
hidden.forEach((g) => g.suspend());
try {
  result = await entry.fn(interruptObj);
} finally {
  hidden.forEach((g) => g.unsuspend());
}
```

Per-handler, not per-chain: each handler in the chain has its own
registration site, so each gets its own hidden set (a handler registered
between two guards is metered by the outer one and not the inner one —
the owner's example 3).

Visibility (which trips a handler may see) uses the same set and lands in
PR 2 Task 2.3, because only trip dispatch consults it.

### Tests for Task 1.3

Gate: the FULL existing handler and interrupt suites green on the new entry
shape before any of the following are added.

1. **The behavioral resume test** (catches the memo bug whatever the
   implementation): program with `handle` at node level; inside it, a guard
   block; inside that, an ordinary interrupt that the handler answers with
   `propagate()`; harness answers; on resume the SAME handler runs again for
   a second interrupt and its own mocked-cost `llm()` is neither gated nor
   charged by the inner guard. Assert the inner guard's spend did not move
   (spend-shaped, decision 13).
2. **Tripped-guard suspension**: a guard that is already over budget
   (mocked cost), an ordinary interrupt raised inside it, the node-level
   handler's own `llm()` must complete — this exercises the pre-call gate
   (prompt.ts:554), which only refuses when a guard is ALREADY over budget;
   an untripped-guard fixture cannot cover it.
3. **Owner example 3**: handler inside `guard(cost: $20)`, adjudicating
   work inside a deeper guard: the handler's `llm()` charges the $20 guard
   (assert by spending it to just under, then over) and never the inner one.
4. **`suspended` never serializes**: handler propagates mid-suspension →
   checkpoint → harness answers → resumed run's guard still meters
   (spend past the limit must trip).
5. **Loop registration**: a handle block inside a `for` loop across two
   iterations, each iteration pushing its own guard; the iteration-2 handler
   is metered by iteration-2's context correctly (pins the memo-key
   loop-iteration hazard from 1.3b).
6. **`preapprove()` passes on `std::guard`** — the 1.3a rule. The full
   trip-shaped fixture lives in Task 2.5's table (trips don't exist until
   PR 2); what PR 1 can and should pin is the unit-level half: the
   preapprove wrapper's handler returns `pass` for a `std::guard`-effect
   interrupt and `approve` for everything else.

---

# Part 5: PR 2 — GuardScope, and cost trips become interrupts

## Task 2.1: `GuardScope` — the runtime object for what `guard(...)` pushes

**What it is.** `guard(cost: $1, time: 5m)` pushes two runtime guards
(Part 1.1). Everything user-facing — the label, the interrupt, the approve
payload with both `maxCost` and `maxTime`, disarm lists, the root refusal —
is about the PAIR. `GuardScope` is the class that represents the pair. It is
not stored anywhere; it is constructed on demand from a stack plus the
member ids (which ARE stored).

**Files:**
- Create: `lib/runtime/guardScope.ts`
- Modify: `lib/stdlib/thread.ts` (`_pushGuard` :263-291)
- Modify: `lib/runtime/guard.ts` (new serialized field `scopeIds`; mutators;
  `isRootBudget`)
- Modify: `lib/runtime/rootBudget.ts` (:23,30 — stamp `isRootBudget`)
- Tests: `lib/runtime/guardScope.test.ts`, additions to `guard.test.ts`.

**Wiring the ids.** `_pushGuard` already computes the id array; it now also
stamps it on each member so the pair can find itself later:

```ts
// In _pushGuard, after both pushes:
for (const g of pushed) {
  g.scopeIds = ids;   // every member knows the whole scope
}
```

`scopeIds` is serialized in `GuardJSON` (it must survive resume, same
reasons as `guardId`, guard.ts:94-97) — and it must ALSO be copied in
`TimeGuard.cloneForBranch` (guard.ts:421-424 copies fields BY HAND;
serialization and cloning are different paths, and the rev-3 review caught
that a field added to one silently misses the other).

**The class:**

```ts
/** The Agency-level guard: the set of runtime guards one `guard(...)`
 *  call pushed (cost, time, or both). Constructed on demand from the
 *  raising branch's stack — NEVER from a global registry, because fork
 *  clones share the parent's guardId and only the branch's own stack
 *  knows which physical object answers to an id there. */
export class GuardScope {
  private constructor(private members: Guard[]) {}

  /** Resolve on the given stack; innermost match per id. Returns the
   *  members present there (a branch stack holds clones; the parent
   *  stack holds originals — both are correct scopes for their branch). */
  static resolve(stack: StateStack, scopeIds: string[]): GuardScope | null;

  /** The member for a dimension, if this scope has one. */
  costMember(): CostGuard | null;
  timeMember(): TimeGuard | null;

  /** True if ANY member is a root budget — the whole scope refuses
   *  extension (decision 9). */
  containsRootBudget(): boolean;

  /** Apply a merged approve payload: additive extends (negative deltas
   *  clamp to zero + runtime warning), then disarms. Throws
   *  GuardApproveError on: unknown dimension for this scope, a root
   *  member, or a payload that leaves the tripped dimension still over
   *  budget and armed (decision 8, checked against `tripped`). */
  extend(payload: ApprovePayload, tripped: "cost" | "time"): void;

  /** The interrupt-data fields: label, per-dimension limits and spend,
   *  which dimension tripped. */
  snapshot(tripped: "cost" | "time"): GuardTripData;

  suspendAll(): void;    // raise-time freeze, PR 2 Task 2.2
  unsuspendAll(): void;
}
```

**Guard mutators** (on the variants, called only by `GuardScope.extend`):

- `CostGuard.extendBudget(delta)`: `costLimit += max(0, delta)`; clear the
  tripped latch. `costLimit` is `readonly` today (guard.ts:165) — make it
  mutable.
- `TimeGuard.extendBudget(deltaMs)`: same, AND reset **both** `tripped` and
  `consumed` (guard.ts:365-371 sets `consumed` before returning the trip;
  resetting only one produces a guard that never trips again — fail-open,
  the worse direction). `timeLimit` mutable (was readonly, guard.ts:317);
  note `cloneForBranch` computes remaining from `timeLimit`, which is the
  Part 3 decision's mechanical hook.
- `disarm(dimension)`: serialized `disarmed` flag; a disarmed guard's
  `check()` never trips and `isTripped()` reports false.
- `isRootBudget`: serialized; stamped by `installRootBudget`.

**Unit tests** (restored from rev 1 plus the review's additions): extend
then spend-under passes, spend-over trips (both dimensions); time extend
re-trips after the new allowance (proves both latches reset); disarm and
`isRootBudget` survive `toJSON`/`fromJSON`; a scope containing a root member
refuses `extend`; `scopeIds` survives BOTH serialization and
`cloneForBranch`; negative delta clamps, warns, and the guard still trips on
the next overspend (the warning is secondary — the metering surviving is
the point).

## Task 2.2: raise cost trips at their detection sites

**Where trips are detected, and what happens at each site.** This is the
taxonomy the plan owes. Cost has FOUR detection sites (Part 1.1), and the
rev-4 review caught that pretending there are two would have silently
disarmed the other two. Time is PR 3.

| # | Context | Detected by | Under this plan | On approve |
|---|---------|-------------|-----------------|------------|
| 1 | Cost, about to send an LLM request | pre-call `enforceGuards` (prompt.ts:554) | raise INSTEAD of sending | the request that was about to go out simply goes out |
| 2 | Cost, a completion just charged past the limit | post-charge check (prompt.ts:699) | raise after booking the charge | the tool loop continues into its next round |
| 3 | Cost, a paid TS helper charging outside llm() | `addCost` (cost.ts:12) | raise at the charge | the helper's caller continues in place |
| 4 | Cost, a subprocess child's telemetry charging the parent's guard | `ipc.ts:897` | KEEPS today's hard path (kill the child, `limit_exceeded`) — documented v1 limitation | n/a in v1 |
| 5 | Time, anywhere (PR 3) | timer → abort signal | depends on what was in flight — see PR 3 | see PR 3 |

Plainly: site 1 means "the model wants to keep going but the next request
would spend past the budget — ask first, send after." Nothing is in flight
while the question is out, and not a cent can leak, because the request was
never sent. Site 2 means "the response we just paid for crossed the line" —
the response is already on the thread; approving just lets the loop
continue. Site 3 keeps `guard(cost:)` uniform: without it, the same guard
would be approvable around `llm()` but hard-fail around a paid TypeScript
helper. All three run inside normal step-body async context (interrupts
raised by tools already work exactly this way), so raising there needs no
new machinery.

Site 4 is the one that CANNOT raise in v1: the telemetry handler is an IPC
message callback with no runner in its async context, and the raise dance
requires one (`agencyInterrupt.ts:129-137` throws without it). So a parent
guard tripped by child telemetry keeps today's behavior — the child is
killed and `run()` reports `limit_exceeded`. Document it in the guards
guide, pin it with a fixture, and file the follow-up (the child's OWN
guards raise in-child as normal, so this only affects a parent budget
enforced across the process boundary).

**`enforceGuards` keeps throwing.** The prompt/addCost sites move to a new
sibling — a `StateStack` METHOD, `stack.detectTrippedGuard(): Guard | null`
(one spelling, everywhere) — and call the raise; the IPC site keeps calling
the throwing `enforceGuards` untouched. Rev 4 said "make it return OR add a
sibling, whichever reads cleaner" — that choice is now forced: changing
`enforceGuards` itself to return would silently disarm the callers this
plan does not rewrite. Fail-open at a budget boundary; the sibling is
mandatory.

**The raising sites LOOP; a single check leaks a request.** One answered
question does not mean the gate is clear: approving the inner guard's trip
can leave — or push — the OUTER guard over its own limit, and decision 16
promises that guard its own question. A raise-once-then-proceed gate would
send the request while the outer guard is over budget and ask the outer
question one request too late, at the post-charge site — contradicting
site 1's headline that not a cent can leak. So both raising sites are:

```ts
let g: Guard | null;
while ((g = stack.detectTrippedGuard()) !== null) {
  await raiseGuardTrip(stack, g, g.dimension);
}
// only now: send the request / book the charge
```

(`dimension` is a new readonly property on the `Guard` interface —
`"cost" | "time"`, the same discriminator `GuardJSON` already carries as
`kind`. A `dimensionOf(g)` helper would need `instanceof` or a JSON
round-trip, both forbidden by the interface contract at guard.ts:20-59.)

The post-charge site needs the same loop for the same reason: one charge
can push an inner guard and its enclosing outer over together, and each is
owed its own question.

**Root guards at every site:** if the over-budget guard `isRootBudget`, do
what happens today — throw `GuardExceededError`. The operator's ceiling
never asks permission. (That is all "root-marked guards keep throwing"
meant.)

**Files:**
- Modify: `lib/runtime/prompt.ts` (:554, :699), `lib/runtime/cost.ts` (:12),
  `lib/runtime/state/stateStack.ts` (add `detectTrippedGuard`;
  `enforceGuards` unchanged)
- Create: `lib/runtime/guardTripInterrupt.ts` (the raise + answer module)
- Modify: `lib/runtime/agencyInterrupt.ts` (factor the raise dance —
  persisted-id check, `interruptWithHandlers`, checkpoint, halt — into a
  helper both callers share)

**The raise, sketched:**

```ts
// In guardTripInterrupt.ts
export async function raiseGuardTrip(
  stack: StateStack,
  tripped: Guard,                   // the member that crossed its limit
  dimension: "cost" | "time",
): Promise<void> {
  // returns = this question is settled (approved, or someone else's answer
  // landed while we were parked) — the caller MUST re-detect, never treat
  // a return as consent to proceed; throws = rejected.
  const scope = GuardScope.resolve(stack, tripped.scopeIds)!;
  if (scope.containsRootBudget()) {
    throw tripped.buildExceededError(stack);      // hard ceiling
  }
  // Dedupe (decision 10, cost only). If another branch's trip for this
  // guard is already open, park on it, then RETURN — the caller's
  // detect→raise loop re-checks the whole stack, which covers both "the
  // answer refilled this guard" and "a different guard is over budget
  // now". (`while`, not `if`: a third branch can claim the record
  // between our wake and our re-check.) If we are first, SET the record
  // before the first await: an async body runs synchronously until its
  // first await, so set-before-await is real mutual exclusion here.
  if (tripped.pendingTrip !== undefined) {
    while (tripped.pendingTrip !== undefined) {
      await tripped.pendingTrip.settled;
    }
    return;                                // caller's loop re-detects
  }
  tripped.pendingTrip = makePendingTrip(); // {settled: Promise, settle: () => void}
  // NOTHING between the set and the try: a throw in that gap would leak
  // the record — never cleared, never settled — and every future branch
  // would park forever, the exact deadlock the finally exists to prevent.
  try {
    const interruptKey = guardTripKey(tripped, dimension);        // see below
    scope.suspendAll();             // freeze clocks + enforcement while deciding
    const verdict = await raiseRuntimeInterrupt({   // the factored dance
      key: interruptKey,
      effect: "std::guard",
      message: buildTripMessage(scope, dimension),
      data: { ...scope.snapshot(dimension), draftValue: readSavedDraft(stack) },
      eligible: (entry) => !entry.liveGuardIds.includes(tripped.guardId),
    });
    if (verdict.type === "approve") {
      scope.extend(verdict.value ?? {}, dimension); // throws the decision-8 error
      return;
    }
    throw tripped.buildExceededError(stack);        // reject → today's pipeline
  } finally {
    // ALL cleanups run on EVERY exit — and there are four: approve
    // (return), reject (throw GuardExceededError), the decision-8 error
    // (throw), and propagate (throw HaltSignal after checkpoint+halt).
    // Settling here is what keeps a fork from deadlocking: three of the
    // four exits leave by a throw, and the propagate answer arrives in a
    // DIFFERENT RUN — a parked sibling waiting for anything else would
    // wait forever, and runBatch's join (`await Promise.allSettled`,
    // runBatch.ts:602) would hang the whole run instead of surfacing the
    // interrupt. Clear the record BEFORE settling so woken branches see
    // it empty; unsuspendAll is a safe no-op if suspendAll never ran.
    scope.unsuspendAll();
    const p = tripped.pendingTrip;
    tripped.pendingTrip = undefined;
    p?.settle();
  }
}
```

**What a parked branch does when the settle came from a halt:** it wakes,
re-checks, finds the guard still over budget, and raises its own trip —
which also propagates. Concurrent branch interrupts are already supported
(`docs/dev/concurrent-interrupts.md`); the user is asked once per branch.
That is the SAME documented trade the dedupe section already accepts for
the restore case, arriving by the same door: the dedupe's guarantee is
"never a silent double-application of one answer," not "never a second
question."

**Why unsuspending during a propagate is safe** (the `finally` runs on the
`HaltSignal` unwind too, which looks like it contradicts "the scope must
not tick while the question is out"): `Runner.halt` already pauses every
guard (runner.ts:253), so nothing ticks while the run is halted; and
`suspended` never serializes, so the checkpoint carries clean guards and
the replayed raise re-suspends them on resume. The suspension bracket
protects the in-process deliberation window; the halt protects the
propagate window. Two mechanisms, one property.

Details that are not optional:

- **The interrupt key is DERIVED from guard state — not counted**
  (decision 14; this was the rev-4 review's second blocker). The key must
  satisfy two properties at once. It must be STABLE across replays of one
  trip: the resume-idempotency machinery (agencyInterrupt.ts:158-162) finds
  the recorded answer by this key, and a key that changes on replay — which
  is what a counter does, because the replayed raise increments again —
  misses the answer and asks the user the same question forever. And it
  must be DISTINCT across different trips of the same scope: a key that
  never changes (`__guardTrip_<scope>` alone) makes trip #2 find trip #1's
  recorded approval and auto-approve forever (the rev-3 blocker in the
  other direction). A derived key gives both:

  ```ts
  function guardTripKey(g: Guard, dimension: "cost" | "time"): string {
    // Stable while THIS trip is open (nothing below changes until it is
    // answered), and necessarily different for the NEXT trip. The five
    // cases: (1) an approved trip extended the tripped dimension, and
    // decision 8 forces the new limit strictly past `spent`, which only
    // grows — so limits strictly increase, @1.00 → @1.50, never a
    // collision; (2) a clamped-to-zero negative delta cannot produce a
    // stale key, because clamping leaves the dimension over budget and
    // armed, and decision 8 ERRORS before this key is ever reused;
    // (3) disarm leaves the limit unchanged, so the key WOULD repeat —
    // but a disarmed dimension never trips again, so there is no next
    // trip to collide with; (4) a rejected trip aborts the scope, no
    // next trip; (5) the other dimension tripping later differs in
    // `dimension`.
    return `__guardTrip_${g.scopeIds.join(",")}#${dimension}@${g.currentLimit()}`;
  }
  ```

  The headline fixture (Task 2.5) exercises both properties: the recorded
  answer must apply exactly once across the resume, and after more
  spending, the SECOND trip (new limit → new key) must actually raise.

  Two statements the rev-5 review asked for, because readers will need
  them. First, WHERE the persisted id lives: in `stack.other`, not
  `frame.locals`. `agency.interrupt` uses frame locals because its key is
  callsite-scoped; the trip key is globally unique per
  (scope, dimension, limit) and the raise happens inside `runPrompt`,
  whose active frame is not the trip's owner — branch-local serialized
  storage that survives frame pops is the right store. The factored raise
  dance therefore takes the store as a parameter (frame locals for the
  `agency.interrupt` caller, `stack.other` for trips). Second, the case
  that looks like a bug until you see it: AFTER an approve, a later replay
  that re-reaches the raise site does not re-raise — not because a key
  matched, but because the extended guard is no longer over budget, so
  `detectTrippedGuard` returns null and nothing raises at all.
- **`eligible`** implements decision 3's visibility half: the chain skips
  handlers whose `liveGuardIds` contains the tripped guard (they are inside
  it). This is a parameter of the factored dance, defaulting to
  "everyone" for ordinary interrupts.
- **Suspension bracket at the raise**, in addition to Task 1.3's per-handler
  bracket: between raise and verdict the scope must not tick or gate
  anything — including during propagate-to-user, where no handler is
  running. `suspended` not serializing (Task 1.3c) is what makes the
  checkpoint-during-propagate case safe.
- **The pending-trip dedupe (decision 10, cost only):** the shared
  `CostGuard` object holds a live (unserialized) `pendingTrip` record
  whose full lifecycle is IN the sketch above — set synchronously with
  the `try` starting on the very next line (the ordering is the mutual
  exclusion; the adjacency is what keeps a throw from leaking the
  record), settled in the `finally` on all four exits (that is the
  fork-deadlock fix), parked branches return on wake and their caller's
  detect→raise loop re-checks the whole stack. Detection stays
  synchronous (`stack.detectTrippedGuard()`); the wait lives only in the
  async raise site. And the "by construction" in cost-only is literal:
  `pendingTrip` lives on the guard OBJECT, and `TimeGuard.cloneForBranch`
  gives each branch its own object, so for time guards the check always
  sees `undefined` and the dedupe no-ops. That is intended — time clones
  are separate real budgets with nothing to dedupe — so do not "fix" the
  missing time dedupe later. Across a checkpoint the live record is gone; what
  bounds over-granting there is the derived key: one recorded answer can
  only ever satisfy one key, and a key names one scope-state
  (`dimension@limit`), so a restored branch re-raising is asking a real,
  new question at the new state — the user is consulted again, never
  silently double-billed a grant. The rev-4 review is right that this is a
  weaker guarantee than the live dedupe (the user can be ASKED more than
  once around a restore); that is the documented v1 trade, pinned by the
  dedupe fixture's restore variant.

## Task 2.3: answering

Covered by the sketch above; what remains is the plumbing contract:

- Approve applies **the merged payload** (Task 1.2 already merged the
  chain); `GuardScope.extend` enforces clamps, disarms, root refusal, and
  the decision-8 error.
- Reject throws the original `GuardExceededError` from the raise point. From
  there, nothing new: `__tryCall` conversion, `AbortedResult`, level rule,
  `finalize`, `success(draft)`/failure — the #553/#556 pipeline, untouched.
- Unknown scope on an approve (id not on the raising branch's stack — can
  only happen via IPC confusion or a stale answer) is a runtime error on the
  response, not a silent no-op.

## Task 2.4: the unhandled path

Because the trip is an ordinary interrupt, propagation, `--policy`, and the
TS-caller path should mostly already work; this task pins them and adds the
one real piece of UI:

- CLI prompt rendering for `std::guard`: show label, dimension,
  spent/limit, and accept an amount (maps to `approve({<dimension>: n})`).
- Fixtures: unhandled trip under `--policy` reject (headless migration
  path); unhandled trip inside a subprocess child (forwards to the parent
  endpoint like any interrupt, #398).

## Task 2.5: the breaking-change migration and the fixture list

**Audit first:** `grep -rn "guard(" stdlib/ lib/agents/`. Two known
consumers of trip-as-failure that MUST be wrapped or their contracts
silently change:

- `stdlib/agency.agency:167` — `run(maxCost:)` wraps the subprocess in
  `guard(cost: cap)` and maps the trip to a `limit_exceeded` failure
  (:181-190). Wrap in `handle ... with (i) { ... reject() ... }` so the
  contract holds.
- `std::agents` — guard scoping is load-bearing there; audit each site.

**Migrate `tests/agency/guards/`** under the byte-identical rule
(decision 13).

**New fixtures** (beyond those named in earlier tasks):

| Fixture | Pins |
|---|---|
| approve-resumes-inline | handler grants, block finishes, result correct |
| approve-across-checkpoint (HEADLINE) | no in-program handler; harness answers `{"action":"resolve","resolvedValue":{"maxCost":0.5}}`; block resumes; a LATER trip still raises (fresh derived key at the new limit; guard state survived serialize/restore) |
| both-dimensions approve | `approve({maxCost, maxTime})` on `guard(cost:, time:)` — the two-member scope actually extends both members |
| omitted-dimension-continues | cost trips; approve cost only; the TIME guard still trips later (fixture asserts only "still trips"; the exact remaining-allowance arithmetic is a unit test — wall-clock margins per decision 13) |
| explicit disarm | `approve({disarm:["cost"]})` stops cost metering; spend past old limit does not trip |
| negative-clamp | guard still trips after a clamped negative approve |
| double-approve spend-gap | two $0.50 grants; $0.75 more spend passes; $1.25 trips |
| shared-guard dedupe | 3 branches, one shared CostGuard, one handler granting $0.50/trip: spend fitting ONE grant passes; spend requiring $1.50 of headroom trips |
| propagate-discards-approvals | inner approves, outer propagates, user rejects → salvage pipeline |
| inside-guard handler blind | handler registered inside the guard never sees its trip; trip surfaces outward |
| livelock error | handler answers `approve({})` → runtime error naming the handler |
| reject-runs-salvage | draft AND finalize variants — the #553/#556 regression surface |
| draftValue preview | `intr.data.draftValue` equals the scope's savedDraft at raise |
| root trio | approve naming a root scope refused; root trip still exits 3 on the spawn path; `isRootBudget` round-trips |
| race-loser trip | a branch with a raised, unanswered trip loses a `race`: no hang, no post-win surfacing (verify against `runBatch.runRace` cancellation) |
| IPC fidelity | disarm arrays and float deltas across the subprocess boundary, asserted by spend |
| addCost-site raise | a paid TS helper (not llm()) crosses the budget: the trip raises and is approvable, same as around llm() (taxonomy site 3) |
| child-telemetry stays hard | a child's telemetry trips the parent's guard: child killed, `run()` reports `limit_exceeded` — pins the documented v1 limitation (site 4) |
| grants-never-cross-budgets | nested guards; approving the inner trip pushes the region over the OUTER limit: the outer guard trips separately, with its own label (decision 16) |
| dedupe restore variant | shared-guard trip open at checkpoint; harness answers; restored branches re-check or re-ask, and total granted headroom is what the answers say — never a silent double-application of one answer |
| preapprove passes on trips | a `preapprove()`d tool trips a guard: the trip propagates past the auto-approve wrapper instead of erroring inside it (Task 1.3a) |
| sibling-branch handler | a handler registered inside fork branch A answers an interrupt raised in branch B: metered by the shared pre-fork guard, hidden from B's local guards (the cross-branch rule, Task 1.3) |

Docs: `docs/site/guide/guards.md` (user-facing semantics + migration),
CHANGELOG, `docs/dev/interrupts.md` (the new machinery).

---

# Part 5b: PR 2 — as executed (deviations and discoveries)

Recorded after execution, for PR 3's benefit and the reviewer's.

1. **The raise lives at PromptRunner gate steps, not at the in-_runPrompt
   check sites.** Raising from inside a non-idempotent llm-call step body
   breaks replay: the body re-pushes its user message on resume. The
   gates (`guardGate.initial`, `round.N.guardGate`, validation gates,
   `guardGate.final`) are idempotent steps of their own, and
   PromptRunner.step's existing bailout machinery provides the message
   snapshot + checkpoint the plan's raise dance would have had to
   duplicate. The in-_runPrompt pre-call check stays as a throwing
   backstop; the post-charge check is REMOVED (its trips raise at the
   next gate; nothing paid runs in between — tool-internal paid work is
   gated by the tool's own runPrompt).
2. **addCost keeps throwing in v1** (taxonomy site 3 moves next to
   site 4): same replay hazard as raising inside _runPrompt, from
   arbitrary TS-helper contexts. `guard(cost:)` around a paid TS helper
   trips non-resumably — documented, revisit with PR 3's machinery.
3. **std::agents guards are NOT auto-reject wrapped** (deviation from
   Task 2.5's migration rule, for owner sign-off): an inner reject
   short-circuits ahead of user handlers, which would permanently lock
   std::agents users out of approving trips — the flagship reviewer
   pattern. run(maxCost:) needed no wrapper at all: its trips fire at
   the exempted IPC site and its limit_exceeded contract is unchanged.
4. **Fixture migration went through the harness, not in-program
   wrappers:** `{"action": "reject"}` entries in test.json — outputs
   byte-identical, and every migrated fixture now exercises the full
   propagate → checkpoint → reject → resume → salvage pipeline.
5. **New boundary fix:** an Interrupt[] reaching a call ARGUMENT passes
   through __call/__callMethod as the call's own result (mirror of
   findAbortedArg). Guard trips are the first runtime-only interrupt
   source, so `f(g())` with a trip inside g was the first way a batch
   could hit an argument slot.
6. **Pre-existing bug found, filed as #559:** resume corrupts frames
   when the interrupt was raised inside a compound call (FIFO frame
   adoption vs replayed completed sibling calls). Affects tool
   interrupts on main today. The one affected fixture case rejects
   in-program with a pointer.
7. **Subprocess trip e2e deferred:** the IPC site is unchanged
   (still throws) and child-side raises forward over the EXISTING
   interrupt IPC; a dedicated child-trip → parent-approve e2e rides
   with PR 3, where re-arm makes the approve path meaningful for the
   remaining dimension.

# Part 6: PR 3 — the abort signal, then time trips

## Task 3.1: derive the composed abort signal

**The problem being removed.** Today every guard install mutates
`stack.abortSignal`: it saves the previous value in `previousSignal`
(guard.ts:453) and overwrites the stack's signal with
`AbortSignal.any([previous, mine])`. Uninstall restores. The composition
order lives implicitly in per-guard fields — order-dependent mutable state.
Re-arming a tripped guard in place means restoring `previousSignal` first,
then re-composing, then rebuilding every composition that was layered above
it. Get the order wrong and you capture the already-aborted composed signal
as "previous," permanently poisoning the stack (the rev-1 review bug).

**The replacement.** The stack OWNS one composite. Guards stop touching
`stack.abortSignal` entirely:

```ts
/** stack.abortSignal is derived: one stable controller per rebuild,
 *  aborted when the base signal or ANY armed, unsuspended guard's own
 *  controller aborts. rebuildAbortSignal() mints a NEW composite (an
 *  aborted controller cannot be un-aborted) and re-subscribes the
 *  current armed set. In-flight operations that captured the OLD
 *  signal were exactly the operations the trip cancelled — new work
 *  reads the getter and sees the new composite. */
rebuildAbortSignal(): void;
get abortSignal(): AbortSignal;
```

Called when the guard array changes (push/pop/rehydrate) and when a guard's
armed state changes (trip approved → re-arm). `previousSignal` is deleted.
`installAbortPlumbing`/uninstall shrink to managing the guard's OWN
controller.

The freshness contract is structural, not a vigilance rule: `abortSignal`
is a GETTER, and the rebuilt composite is what it returns from the moment
of the rebuild. An operation captures the signal when it starts (that is
how AbortSignal is used everywhere in the runtime already); an operation
that captured the OLD composite was, by definition, in flight when the trip
fired — which means it is exactly the operation the trip cancelled. New
work started after the approve reads the getter and gets the live
composite. No reader audit is needed because there is no way to hold the
stale signal AND be alive.

The nested-guards fixture rides here as a regression pin: two nested time
guards, outer trips, approve, inner still cancels its own work later.

## Task 3.2: time trips

The taxonomy row 3 from Task 2.2, now in full. A timer fire can catch the
branch in three places, and only ONE of them needs anything clever:

- **(a) An LLM request is in flight.** The signal cancels it (today's
  behavior, `promptCancelled` statelog pairing intact). `runPrompt`'s
  cancellation path recognizes the cause as a guard trip, and instead of
  rethrowing: rebuild the signal (Task 3.1 — the chain and `runPrompt`
  refuse aborted stacks, interrupts.ts:234 / prompt.ts:542, so re-arm MUST
  precede dispatch), then raise. On approve, **re-issue the request from the
  current thread state.** This is safe against your tool-call question by
  construction: the loop only ever has a request in flight when every prior
  `tool_use` already has its result appended (results are appended before
  the next request is issued). The cancelled request produced no assistant
  message. So "re-issue" means: send the exact same conversation again. The
  cancelled generation's partial output is honestly gone and the retry is a
  fresh request; that cost is charged like any request.
- **(b) A tool is executing** (Agency code inside a tool call). The abort
  surfaces at the tool code's next step boundary or leaf op. Raise there;
  on approve the tool CONTINUES where it paused, finishes, and its result is
  appended to the thread normally — identical shape to a tool that raised
  an ordinary interrupt and got resumed. No thread surgery; there is never a
  dangling unanswered `tool_use`, because the tool call completes on resume.
- **(c) Plain Agency code between LLM calls** (a loop, a `sleep`). Same as
  (b): the abort surfaces at a step boundary or the aborted `sleep`; raise;
  on approve, continue in place.

So: (b) and (c) resume in place with zero message-thread involvement; only
(a) re-issues, and (a) cannot have pending tool results by construction.
Reject in all three: rebuild-then-re-abort, throw the trip at the raise
point, salvage pipeline as always.

Fixture discipline (decision 13): the deterministic assertions are statelog
pairing (`promptStart`/`promptCancelled`) and spend-shaped re-trip checks;
wall-clock margins only where the behavior is irreducibly temporal.

## Task 3.3: the join rule (decision 15)

`TimeGuard.extendBudget` records the clone's granted total in a serialized
field (`grantedMs`, riding `GuardJSON` and the clone-serialization path
that already carries clones across checkpoints). At the join, `runBatch`
charges the parent with ONE branch's working time — the longest — so the
parent's extension is THAT branch's `grantedMs`, applied before
`addElapsed`. Not the max grant across branches: the time and the grant
must come from the same branch, or a short branch with a big grant would
widen the parent for time nobody spent. The rule is self-consistent in a
way worth noticing: the longest branch is necessarily a granted branch
whenever it matters, because a clone without a grant would have tripped at
its own limit instead of running past it.

Fixture: fork; one branch's clone trips; approve 5 more minutes; branch
finishes; join; the parent does not trip (spend-shaped where possible per
decision 13, wall-clock margins only for the irreducible part). And the
decision-16 boundary: the parent's ENCLOSING guard, if any, is untouched —
if the extra granted time pushes it over, it trips with its own label.

---

# Part 6b: PR 3 — as executed (deviations and discoveries)

Recorded after execution, for PR 4's benefit and the reviewer's.

1. **`TimeGuard.check()` is now clock-based.** The plan assumed the
   timer's `tripped` latch was the detection truth. It is not: a tight
   Agency loop is an unbroken microtask chain that starves the
   setTimeout macrotask, so busy loops escaped time guards ENTIRELY
   (pre-existing, not a PR 3 regression). check() now compares elapsed
   working time against the limit directly; the timer stays as the
   eager notifier that cancels in-flight leaf ops.
2. **The raise point lives in `Runner.hook` as well as `Runner.step`.**
   Loop-body statements compile to `runner.hook`, not `runner.step` —
   without the hook-side raise, the busy-loop fixtures never detected
   anything. Discovered by inspecting generated code.
3. **Cost guards are excluded from the step-boundary raise**
   (`Guard.raisableTripAtStep()`, cost → false). The first full sweep
   failed 43 fixtures because the runner raise point re-asked cost
   questions the PromptRunner gates had already settled — and delivered
   their rejects at steps OUTSIDE the owning guard boundary, where
   nothing converts them. Cost only ripens at paid actions, and every
   paid action already sits behind a gate; the runner surface is for
   time, which burns between sync points. The raise loop uses a
   step-scoped detector (`stack.detectStepRaisableTrip()`) for the same
   reason.
4. **Guards settle when `_runGuarded` exits** (`stack.settleGuards`,
   implemented as suspend + signal rebuild). Between the block's exit
   and `_popGuard` there is exactly one runner step, and a clock
   crossing its limit there raised a question about work that had
   already concluded — approve would grant time to nothing, and a late
   timer fire could flip a computed success into a failure (an old
   race, now closed). Suspension is not serialized, so a checkpoint
   taken during the `_popGuard` step reopens the window for that one
   replayed step; harmless, not worth a serialized flag.
5. **The raise fires inside tool bodies as planned (case b)** — no
   tool-window exemption. It rides the same in-tool interrupt path as
   an `input()` inside a tool; the `toolBodyApproved` fixture pins
   approve → tool completes on resume → result reaches the thread.
6. **Mid-request re-issue is a step-level wrapper, not an
   in-`_runPrompt` loop.** `_runPrompt` classifies the cancellation by
   its `guardTrip` cause and throws a control error
   (`GuardTripRetry`); `requestStepWithTripRetry` wraps the request
   steps, catches it, runs a gate step (`<key>.retryGate.N`), and
   re-issues. The prompt push was hoisted into its own idempotent
   `pushPrompt` step so a re-issue (or a resumed replay) never
   duplicates the user message; the injected-recall-facts removal moved
   into a `finally` for the same reason. The wrapper also probes before
   the body, which is what makes a RESTORED over-budget guard raise
   before the request re-runs.
7. **The deterministic mock gained an abortable `delayMs`** so the
   mid-request fixtures are real: the mock "generates" for 60 seconds
   against a 100ms budget, the trip's abort cancels it through the same
   signal path a provider request uses, and it rejects with
   `signal.reason` so the cause classification is exercised.
8. **The join rule applies grants only alongside a real charge.** As
   planned otherwise; but `extendBudget(grant)` is gated on `acc > 0`
   (and `grant > 0`) — extendBudget(0) would still reset the
   tripped/consumed latches and re-arm a trip the parent had already
   delivered, and a grant must not follow time that is not billed.
9. **In-flight `sleep()` cancellation keeps the leaf path.** A timer
   fire mid-sleep still delivers through `__tryCall`'s cause conversion
   (`delivered` flag), not the runner raise —
   `Guard.raisableTripAtStep()` excludes delivered trips, which is what
   keeps the two paths from double-asking. The old
   guard-time-* fixtures pass unmodified because of this.
10. **The subprocess child-trip → parent-approve e2e (PR 2 note 7) did
    not ride along.** The IPC telemetry site is unchanged and
    child-side raises still forward over the existing interrupt IPC;
    the dedicated e2e now rides with PR 4, which touches the message
    channel anyway.

# Part 7: PR 4 — the feedback channel

Small by design; everything it needs exists by now.

- `approve({message})`: the merged message (Task 1.2 joins multiples with
  newlines) goes into a branch-local pending queue; the tool loop drains the
  queue into the thread as a user-role message before the next model request
  — the exact reply-attachments pattern (`docs/dev/reply-attachments.md`),
  whose injection point already exists.
- Injected messages are pushed with an auto-label (`guard:<label>`) via
  `MessageThread.push(message, label)` from #557, so statelog and thread
  dumps distinguish reviewer feedback from real user messages.
- Outside an LLM loop, the message waits and lands on the branch's next
  `llm()` call.
- Fixtures: message lands as user-role before the next request (statelog
  message dump), auto-label present, two approvals' messages both present in
  order.

---

# Part 8: Estimates and sequencing

| PR | Contents | Estimate |
|---|---|---|
| 1 | pass(), merge table, registration-site scoping | 4–5 days (1.3 is safety-critical and carries the suite-green gate) |
| 2 | GuardScope, cost trips, dedupe, migration | 5–6 days (the audit + ~29 fixture migrations are real work) |
| 3 | signal derivation, time trips, join rule | 3–4 days (3.1 front-loads what the old representation was hiding) |
| 4 | feedback channel | 1 day |

Each PR gets its own review round. PR 1 and the #557 labels PR are
independent and can land in either order; PR 4 needs both.
