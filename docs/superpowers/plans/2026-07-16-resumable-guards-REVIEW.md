# Plan review: resumable guards (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (DRAFT)
**Verdict:** Do not execute yet. The decisions section is sound and the risk
sections (fork/race/IPC) are the best part of the document. But three claims the
plan treats as settled are contradicted by the code, and one of them
(the handler's own budget) is a design hole, not a plan bug — it needs an owner
decision before PR 1 can be scoped honestly.

All line references are `packages/agency-lang/`.

---

## Blocking findings

### 1. The handler runs INSIDE the tripped guard, un-paused. This breaks the flagship example.

This is the big one. Both the spec and the plan assume that once a trip raises,
the world is frozen while the handler deliberates. It is not.

`interruptWithHandlers` runs the handler chain FIRST and only calls
`runner.halt(...)` if nobody answered (`agencyInterrupt.ts:168` vs `:203`). So on
the approve/reject path — the whole point of this feature — **no halt ever
happens**, which means `Runner.halt`'s `guards.forEach(g => g.pause())`
(`runner.ts:253`) never runs.

Two consequences:

- **Decision 3's justification is wrong.** "The clock is frozen while the trip
  waits for an answer" is true only for the propagate-to-user path. On the
  handler path the TimeGuard keeps ticking while the reviewer agent thinks.
- **The reviewer-redirect example cannot run.** The handler body executes in the
  raising branch's async lineage, so `getRuntimeContext().stack` still carries
  the tripped guard. The reviewer agent's first `llm()` hits the pre-call gate
  `targetStack.enforceGuards()` (`prompt.ts:554`), which walks `stack.guards`,
  finds the still-over-budget CostGuard, and throws `GuardExceededError` —
  *inside the handler chain*, out of the raise site, as an unhandled abort.

So the design owes an answer to a question neither doc asks: **what budget does
the handler itself run under?** Plausible options — the owner should pick, not
the executor:

- (a) Disarm the tripped guard for the duration of the handler chain, re-arm per
  the answer. Simple, but a runaway reviewer agent is then unmetered.
- (b) Run the handler chain on a stack with the tripped guard's subtree elided.
- (c) Declare it the user's problem: document that a handler that spends money
  must wrap its own work in `guard(...)` and cannot use the tripped budget.

Whatever the answer, it changes PR 1's task list. Today's plan has no task for
it.

### 2. Time trips: the handler chain refuses to run on an aborted stack.

`runHandlerChain` opens each iteration with
`if (ctx.isCancelled(stack)) throw new AgencyCancelledError()`
(`interrupts.ts:234`). At a time trip the composed `stack.abortSignal` is
aborted, so the chain throws before invoking a single handler. The same gate sits
at the top of `runPrompt` (`prompt.ts:542`), so even if the chain ran, the
reviewer's LLM call would be refused.

This inverts the plan's Task 3 ordering. The plan says: apply the answer, then
"re-arm the branch's abort plumbing." For time trips the re-arm must happen
**before** the handler chain runs, and `reject()` must then re-abort. That is a
different mechanism, and it lands in PR 2, whose current write-up is four
bullets long.

### 3. "Root budgets keep throwing... the walk distinguishes them by the existing root marker."

There is no root marker. `installRootBudget` pushes plain
`new CostGuard(cost)` / `new TimeGuard(ms)` onto the root stack
(`rootBudget.ts:23,30`) — structurally identical to a user guard. Nothing today
tells them apart.

This matters because "user code cannot approve its way past the operator's
ceiling" is the one hard safety property in the design. The marker has to be
added (a flag on the guard, serialized in `GuardJSON` like `guardId` and
`disarmed`, checked at the raise site AND in the approve mutator so an approve
naming a root guard's id is refused). That is a real task in PR 1, currently
written as a verify-only sentence.

---

## Substantive findings

### 4. PR 1's stated raise site does not fire for PR 1's trips.

Task 2 anchors the raise at `shouldSkip()` (`runner.ts:315`), and the
architecture line says trips "already surface" there. That is true for time
trips. It is false for cost trips, which is all of PR 1.

The entire guard walk in `shouldSkip` lives inside
`if (this.stack?.abortSignal?.aborted && !this.halted)`. `CostGuard` installs no
AbortController and its `isTripped()` returns a hardcoded `false`
(`guard.ts:203`, documented at `guard.ts:124-136`). A cost trip never aborts the
signal, so `shouldSkip` never even walks the guards. Cost trips are thrown by
`enforceGuards()` (`stateStack.ts:569`) from `prompt.ts` — the pre-call gate at
`:554` and the post-charge site at `:699`. That is mid-tool-loop, deep inside a
step body.

So PR 1 has to answer a question the plan skips: turning that throw into
"mark pending, raise at the next step boundary" means the *pre-call gate* stops
throwing, and the tool loop will happily issue more requests past budget before
control returns to a step boundary. Either the raise happens where the trip is
detected (inside `prompt.ts`, which is where the frames are still alive anyway),
or the pending window has to be provably zero-cost. This choice is PR 1's
architecture, and it is currently a sentence pointing at the wrong file.

Related: `shouldSkip` is **sync**. Task 2's "returns true-to-skip only after the
raise resolves" is not implementable there. `maybeDebugHook` is the async
step-boundary precedent the plan cites, and it is called from `step()`, not from
`shouldSkip`.

### 5. The re-arm precedent (`guard.ts:57`) does not transfer.

Task 3 calls the fresh-controller re-arm "the single most load-bearing detail of
PR 1" and grounds it in checkpoint-resume. Two problems.

First, it is not a PR 1 detail at all — cost trips fire no abort signal, so there
is nothing to re-arm (see finding 4). It belongs to PR 2.

Second, the precedent is weaker than the plan thinks. `resume()` rebuilds
plumbing only when `!this.controller` (`guard.ts:356`), which is true after
deserialization and false for an in-place approve. And `installAbortPlumbing`
sets `previousSignal = stack.abortSignal` (`guard.ts:453`) — calling it again in
place would capture the **already-aborted composed signal** as the "previous"
one, permanently poisoning the stack. An in-place re-arm must restore
`previousSignal` first, then re-compose.

Worse, with nested time guards the composition is a chain: an inner guard
installed after the tripped one did `AbortSignal.any([outerComposed, mine])` and
holds the aborted `outerComposed` as its own `previousSignal`. Un-aborting the
tripped guard means rebuilding every composition above it. Nothing in the plan
covers this, and there is no existing helper for it. Suggest a fixture: nested
time guards, outer trips, approve, inner guard still enforces afterward.

### 6. Negative-as-disarm collides with additive arithmetic. Fail-open direction.

Decisions 2 and 4 put two meanings on one number: `maxCost` is a delta to add,
except any negative value silently disarms metering entirely. So a handler that
computes `approve({maxCost: budget - alreadySpent})` disarms the guard the moment
that expression goes negative. For a cost-control feature, the accidental
outcome is unbounded spend.

Negative-as-disable is an established convention (`guard(cost: -1)`,
`rootBudget.ts:22`, the `NO_COST_CAP` idiom in `stdlib/agency.agency:165`), but
there it decorates a *construction* argument where no arithmetic happens. In an
additive channel it is a different thing wearing the same clothes. Recommend an
explicit key (`approve({disarm: ["cost"]})`) or clamping deltas at zero. Cheap
now, breaking later.

Note also that "disarmed" is a genuinely new third state: today a disabled
dimension means *no guard was installed at all*, not an installed guard that
never trips. `disarmed` therefore needs the serialization treatment the plan
gives it, plus a decision on what `isTripped()` reports for a disarmed guard that
already tripped once.

### 7. The migration list misses the stdlib's own guard users.

Task 5 scopes the breaking change to `tests/agency/guards/` plus docs. But
`stdlib/agency.agency:167` wraps subprocess `run()` in `guard(cost: cap)` and
branches on `guarded is failure(err)` / `err.type == "guardFailure"` to produce
the `limit_exceeded` shape (`:181-190`). Under uniform-interrupt semantics that
trip stops being a failure and becomes an interrupt propagating to the user
endpoint — silently changing `run(maxCost:)`'s contract for every caller.

`std::agents` is the other likely site (guard scoping is load-bearing there).
Task 5 should start with an audit: `grep -rn "guard(" stdlib/ lib/agents/`, and
every internal caller that consumes a trip as a value gets an explicit
`handle ... with { reject() }` wrapper. Right now these would ship as an
unnoticed regression, since the guards fixture sweep would not catch them.

### 8. `__guardTrip_<guardId>` keyed on `frame.locals` contradicts its own rationale.

Task 2 wants the key on the frame "not by step path — the same trip must be
answerable no matter which step boundary sees it first." But `frame.locals` is
per-frame, and different step boundaries live in different frames: an inner
frame's boundary raises and persists the id, the inner frame returns and pops,
the outer frame's next boundary sees the same pending trip, misses the lookup,
and re-raises. Frame-local storage buys nothing that step-path keying does not,
and loses exactly the property the plan wants. If the id must be branch-scoped,
put it where branch-scoped state already lives (`stack.other`, which is
branch-local and serialized).

---

## Smaller notes

- **Open question 1** — yes, option (b). A handler answering `approve({})` should
  get a runtime error, not a livelock. Note this is only reachable because
  omitted-continues (decision 3) makes `approve({})` a legal no-op; the error is
  the price of that uniformity, and it is worth paying.
- **Open question 4** — `reject()` needs no plumbing changes; `renderVerdict`
  already carries reject with no value and reject-precedence is unconditional
  (`interrupts.ts:274`, `mergeChainOutcomes` at `:315`). You can close this now.
- **Open question 2** — generic events plus payload is right, and it costs
  nothing to revisit later.
- `TimeGuard.check()` sets `consumed = true` before returning the trip
  (`guard.ts:365-371`). Task 1's mutator must reset `consumed` as well as
  `tripped`, not just "the consumed/tripped latch" as one thing — they are two
  fields with different jobs, and missing `consumed` produces a guard that never
  trips again (fail-open) rather than one that re-trips.
- **Estimate.** 3–4 days for PR 1 is not credible once findings 1, 3, and 4 turn
  into tasks — the raise mechanism for cost trips is unwritten, the root marker
  is new work, and the handler-budget decision may add a stack-scoping mechanism.
  Re-estimate after the owner answers finding 1.

## What the plan gets right

Worth saying: the fork/race/IPC section is the strongest part and I found nothing
wrong in it. Case 2's rule (resolve approve from the interrupt's own StateStack,
never a global id lookup) is correct and load-bearing — `cloneForBranch` does
carry the parent's guardId (`guard.ts:423`). Case 1's shared-cost-guard reasoning
matches `CostGuard.cloneForBranch` returning `this` (`guard.ts:210`). Case 5's
"the mutation happens where the answer is applied, in the child that owns the
guard" is right by construction. Decision 5 (no `thread` in v1) is the right
scope cut.

## Recommended next steps

1. Owner decides finding 1 (the handler's own budget). Everything else in PR 1
   is downstream of it.
2. Rewrite Task 2 around the real cost-trip detection sites in `prompt.ts`, and
   state explicitly whether the raise is at the detection point or deferred to a
   step boundary — with the "how much can be spent in the pending window" answer.
3. Promote the root marker and the abort re-arm out of "verify this" into real
   tasks, the re-arm in PR 2 where it belongs.
4. Add the stdlib migration audit to Task 5.
5. Re-estimate.
