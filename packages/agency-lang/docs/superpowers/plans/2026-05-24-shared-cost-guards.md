# Shared Cost Guards (Real-Time Mid-Fork Enforcement)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `guard(cost: $X)` enforce its budget across all concurrent descendants in real time, not just on fork-join. Today each fork branch gets an isolated clone of the parent's `CostGuard`, so an outer `$2.00` budget can be silently exceeded mid-fork when two branches each reach `$1.25` — neither inner clone trips, and the trip only fires after the fork settles. After this change the parent's guard is a single shared in-memory object referenced by every descendant branch; any LLM call that pushes total spend over the limit trips the outer guard immediately, aborting all siblings via the existing `composeBranchAbortSignal` cascade.

This also adds a **pre-call gate** to `prompt.ts`: before sending an LLM request, check every guard on the stack. If we're already over budget (because of siblings' spend or a prior call), refuse the new call instead of incurring its cost and tripping after the fact.

**Reference prior work:**
- Cost guards: [`docs/superpowers/plans/2026-05-23-builtin-cost-guards.md`](2026-05-23-builtin-cost-guards.md)
- Time guards (the `Guard` interface + abort controller pattern this plan extends): [`docs/superpowers/plans/2026-05-24-timeout-guards.md`](2026-05-24-timeout-guards.md)
- Existing per-branch isolation behavior: [`Runner.seedBranchCost`](../../lib/runtime/runner.ts#L255-L294) and [`CostGuard.cloneForBranch`](../../lib/runtime/guard.ts#L122-L126)
- Existing join-time rollup: [`Runner.propagateBranchCost`](../../lib/runtime/runner.ts#L304-L316) and the `propagateBranchCost` / `propagateLoserCost` / `propagateWinnerCost` hooks on [`runBatch`](../../lib/runtime/runBatch.ts)
- The abort cascade we re-use: [`StateStack.abortSignal`](../../lib/runtime/state/stateStack.ts#L275), [`composeBranchAbortSignal`](../../lib/runtime/runBatch.ts#L183-L194)
- Worked example + design rationale: discussion thread [T-019e5c23-2f65-735c-bebc-2a7b42a40774](https://ampcode.com/threads/T-019e5c23-2f65-735c-bebc-2a7b42a40774)

---

## Design

### The shared-guard model

`CostGuard` becomes a stateful in-memory object that holds its own running `spent` counter (instead of deriving from a single stack's `localCost`). Every LLM-cost site walks `stack.guards` and calls `guard.charge(cost)` on each one; charges accumulate on the guard itself.

`CostGuard.cloneForBranch` returns `this` (a shared reference) instead of a fresh clone. So when a fork begins, every branch's `stack.guards` includes the *same* live `CostGuard` JS object that the parent holds. Any branch charging the shared guard mutates the counter the parent and all siblings see — single-threaded JS makes this race-free.

When the shared counter crosses the limit, `check()` returns a `GuardExceededError` AND the guard's `AbortController` fires (same pattern `TimeGuard` already uses). The signal was composed into the parent's `stack.abortSignal` at install, and each branch's `stack.abortSignal` is composed off the parent's via [`composeBranchAbortSignal`](../../lib/runtime/runBatch.ts#L183-L194). So every running branch wakes, halts at its next step, and surfaces the typed throw via its own `check()` call.

Inner guards pushed *after* a fork opens (e.g. `guard(cost: ...) { inside_branch }`) stay branch-local — they're pushed onto the child's stack, never visible to the parent. So you can mix "outer hard cap shared across siblings" with "inner per-branch sub-budget" naturally.

### Pause/resume — the `inheritedGuardCount` invariant

Each `StateStack` gains a single integer field: `inheritedGuardCount`. Set to `0` on the root stack. When a child branch is seeded, set `child.inheritedGuardCount = parent.guards.length` BEFORE prepending the parent's live guard references into the child's `guards`. Anything at index `≥ inheritedGuardCount` is owned by the child.

```diagram
Parent stack at fork time:
  guards = [OUTER]                  parent.inheritedGuardCount = 0

Each child stack immediately after seeding:
  guards = [OUTER ref]              child.inheritedGuardCount = 1

After child pushes its inner $1.50 guard:
  guards = [OUTER ref, inner_b1]    child.inheritedGuardCount = 1
                                    (inner_b1 is child-owned; index ≥ 1)
```

Serialization:
- `stack.toJSON()` serializes `guards.slice(stack.inheritedGuardCount)` only — own guards.
- The shared `OUTER` is serialized exactly once, on the parent's snapshot.
- `inheritedGuardCount` is serialized so resume knows how many to re-prepend.

Resume:
- `parentStack` is restored from the batch checkpoint → `OUTER` rehydrates with its `spent` counter intact.
- When `runBatch` rehydrates a child on resume:
  ```ts
  const childStack = StateStack.fromJSON(branchJson.stack);
  // childStack.guards currently only has branch-owned guards.
  const inherited = parentStack.guards.slice(0, childStack.inheritedGuardCount);
  childStack.guards = [...inherited, ...childStack.guards];
  ```
- Now child's `guards[0]` is the SAME JS object as `parent.guards[0]`. Real-time sharing fully restored.

`AbortController`s are not serialized; `OUTER.resume(stack)` rebuilds them at the parent's first step after restore, exactly like `TimeGuard` does today.

### Pre-call gate

In [`prompt.ts`](../../lib/runtime/prompt.ts), wrap the LLM dispatch with:

```ts
// Pre-call: refuse if any active guard is already over budget.
for (const g of stack.guards) {
  const trip = g.check(stack);
  if (trip) throw trip;
}

// ...send request, await response, compute cost...

stack.localCost += cost;
for (const g of stack.guards) g.charge(cost);
for (const g of stack.guards) {
  const trip = g.check(stack);
  if (trip) throw trip;
}
```

Pre-call reads the live shared `OUTER.spent`, so if siblings have already pushed total past the limit, this call refuses to start. Post-call accounting unchanged.

---

## Out of scope

- **Token-cost pre-call estimation.** A cheap "are we already over?" gate is all this plan adds. Estimating output-token cost upfront is a separate, larger change.
- **Time guards.** `TimeGuard` already has the shared model (parent's timer is single source of truth; abort cascade enforces). No changes to time enforcement.
- **General event/observer framework on the runtime.** Discussed in the design thread and explicitly rejected for now — cost is a ledger, not an event stream.
- **`stack.localCost` / `propagateBranchCost` removal.** Both stay. `localCost` is used by `getCost()` and observability; `propagateBranchCost` still ensures parent's `localCost` is correct after a branch settles, independent of the shared-guard mechanism.

---

## Tasks

### Task 1: Refactor `CostGuard` to track its own `spent` counter

- [ ] **Step 1.** Add to [`lib/runtime/guard.ts`](../../lib/runtime/guard.ts):
  - `Guard.charge(amount: number): void` — required on the interface. `TimeGuard.charge` is a no-op.
  - `CostGuard` gains `private spent: number = 0`. `charge` mutates `spent`. `check` becomes `if (this.spent > this.costLimit) return new GuardExceededError("cost", this.costLimit, this.spent)`.
  - `CostGuard.install` no longer needs `costAtPush`; remove the field. (Its purpose was to compute `branch.localCost - costAtPush` deltas — replaced by the explicit `spent` counter.)
  - `CostGuard.toJSON` adds `spent`. `CostGuard.fromJSON` restores it.
  - `CostGuard` gains an `AbortController` field + `install`/`uninstall`/`resume` plumbing copied from `TimeGuard.installAbortPlumbing`. When `check` is about to return a trip, also call `this.controller?.abort()` so the cascade fires.
- [ ] **Step 2.** Update `Guard.check` invocation sites:
  - [`prompt.ts`](../../lib/runtime/prompt.ts): change the post-LLM cost block to call `g.charge(cost)` on every guard before calling `g.check(stack)`.
  - [`StateStack.checkGuards`](../../lib/runtime/state/stateStack.ts) (or wherever the centralized helper landed in the timeout-guards branch): unchanged — it still walks `guards` and calls `check`.
- [ ] **Step 3.** Unit tests for `CostGuard`:
  - `charge` mutates `spent`.
  - `check` returns null below limit, returns `GuardExceededError` above.
  - `check` is idempotent — after a trip, subsequent `check` calls still return the trip (so the parent's runner observes it on its next step). Or follow `TimeGuard`'s "consumed once" pattern if cleaner.
  - `toJSON`/`fromJSON` round-trip preserves `spent`.

**Files:** [`lib/runtime/guard.ts`](../../lib/runtime/guard.ts), [`lib/runtime/prompt.ts`](../../lib/runtime/prompt.ts), [`lib/runtime/state/stateStack.ts`](../../lib/runtime/state/stateStack.ts), `lib/runtime/guard.test.ts` (new tests).

### Task 2: Shared-reference `cloneForBranch` + `inheritedGuardCount`

- [ ] **Step 1.** Add `inheritedGuardCount: number = 0` to [`StateStack`](../../lib/runtime/state/stateStack.ts).
- [ ] **Step 2.** `StateStack.toJSON` change:
  ```ts
  guards: this.guards
    .slice(this.inheritedGuardCount)
    .map((g) => g.toJSON()),
  inheritedGuardCount: this.inheritedGuardCount,
  ```
- [ ] **Step 3.** `StateStack.fromJSON` change: restore `inheritedGuardCount`. Deserialized `guards` is initially just the own guards (whatever was serialized) — re-prepending happens in `runBatch`, not in `fromJSON` (because `fromJSON` doesn't know about the parent).
- [ ] **Step 4.** Change `CostGuard.cloneForBranch` to `return this;` (shared reference). Remove the rebased-baseline code.
- [ ] **Step 5.** Change [`Runner.seedBranchCost`](../../lib/runtime/runner.ts#L255-L294):
  ```ts
  // Set inheritedGuardCount BEFORE pushing refs.
  branchStack.inheritedGuardCount = parentStack.guards.length;
  // Existing map+filter; CostGuards now return `this`, TimeGuards return undefined.
  branchStack.guards = parentStack.guards
    .map((g) => g.cloneForBranch(parentStack, branchStack))
    .filter((g): g is NonNullable<typeof g> => g !== undefined);
  ```
  Note: the existing `localCost`/`seedCost` seeding stays. They're orthogonal — they keep `getCost()` and `propagateBranchCost` correct for the per-stack accounting; guards now use their own counter.

**Files:** [`lib/runtime/state/stateStack.ts`](../../lib/runtime/state/stateStack.ts), [`lib/runtime/guard.ts`](../../lib/runtime/guard.ts), [`lib/runtime/runner.ts`](../../lib/runtime/runner.ts).

### Task 3: Resume-time re-link in `runBatch`

- [ ] **Step 1.** Add a helper in [`lib/runtime/runBatch.ts`](../../lib/runtime/runBatch.ts):
  ```ts
  /** Re-link inherited (parent-owned) guard references onto a child
   * stack that was just rehydrated from JSON. Must run AFTER
   * StateStack.fromJSON and BEFORE the child's invoke is called. */
  function rehydrateInheritedGuards(
    childStack: StateStack,
    parentStack: StateStack,
  ): void {
    const inherited = parentStack.guards.slice(
      0,
      childStack.inheritedGuardCount,
    );
    childStack.guards = [...inherited, ...childStack.guards];
  }
  ```
- [ ] **Step 2.** Call it on every resume path in `runBatch`:
  - Top of `runBatch` before iterating tasks: for each existing branch that has interrupt state (was rehydrated from the prior checkpoint), call `rehydrateInheritedGuards(branch.stack, parentStack)`. Should happen before `composeBranchAbortSignal` so the composed signal sees the freshly-installed parent guards' controllers (after `OUTER.resume()` rebuilt them at parent's first step).
  - `runRaceResume`: same call before `child.invoke(branch.stack, signal)`.
- [ ] **Step 3.** Idempotency guard: re-running `rehydrateInheritedGuards` on a stack that already has inherited refs would double-prepend. Either:
  - Track a `rehydrated: boolean` flag on `BranchState`, or
  - Check `childStack.guards.length < childStack.inheritedGuardCount + ownGuardCount` — if it's already full, skip.

  Prefer the flag; it's local to the live `BranchState` (already not serialized) and survives multiple `runBatch` re-entries in the same execution.

**Files:** [`lib/runtime/runBatch.ts`](../../lib/runtime/runBatch.ts), [`lib/runtime/state/stateStack.ts`](../../lib/runtime/state/stateStack.ts) (the `rehydrated` flag).

### Task 4: Pre-call gate in `prompt.ts`

- [ ] **Step 1.** In [`prompt.ts`](../../lib/runtime/prompt.ts), find the LLM dispatch (the `client.complete(...)` / `client.respond(...)` site). Immediately before it, add:
  ```ts
  for (const g of stack.guards) {
    const trip = g.check(stack);
    if (trip) throw trip;
  }
  ```
- [ ] **Step 2.** Verify the throw is caught by the existing function-body auto-wrap (the same path that catches the post-call trip today). It should be — `GuardExceededError` is on the allow-list.
- [ ] **Step 3.** Add a unit test in `tests/agency/guards/`: spend $X via a sibling branch so the shared guard is already tripped, then attempt another LLM call. The pre-call gate must trip without the new call being issued. Assert via call count on the mock provider.

**Files:** [`lib/runtime/prompt.ts`](../../lib/runtime/prompt.ts), `tests/agency/guards/guard-cost-pre-call-gate.agency` (new).

### Task 5: End-to-end regression tests

- [ ] **`tests/agency/guards/guard-cost-shared-outer-trips-mid-fork.agency`** — The motivating example from the design discussion: outer `$0.000008` budget, fork of 3 branches each spending `$0.000003` (over budget in total, under per-branch). Outer must trip mid-fork before all branches finish; assert via the trip's `actualCost` being close to the limit (not 3 × per-branch).
- [ ] **`tests/agency/guards/guard-cost-shared-survives-interrupt.agency`** — Same setup, but the first branch interrupts before reaching the trip threshold. Harness approves; resume completes the rest. After resume, the outer trip must still fire when total spend crosses the budget. Regression for the `inheritedGuardCount` re-link path.
- [ ] **`tests/agency/guards/guard-cost-shared-inner-still-isolated.agency`** — Outer `$0.001`, each branch pushes its own inner `$0.000003` guard. One branch spends `$0.000004` (inner trips, branch fails). Other branches' inner guards untouched. Outer never trips (total under outer limit). Asserts the "inner pushed after fork stays branch-local" invariant.
- [ ] **`tests/agency/guards/guard-cost-pre-call-gate.agency`** — Pre-existing spend exceeds budget; next LLM call must trip without being sent. Mock provider call count = N-1, not N.
- [ ] **`tests/agency/guards/guard-cost-shared-nested-fork.agency`** — Outer guard at depth 0, inner fork at depth 2. Verifies inheritance walks: depth-2 branches see depth-0 outer guard via the depth-1 branch's `guards` array (which itself contains the depth-0 ref via inheritance). Trip from the deepest leaf must abort everything.

### Task 6: Audit existing tests for behavior changes

- [ ] Re-run the full `tests/agency/guards/` suite. Some existing tests assume the join-time-only behavior — review each failing test and decide whether it should:
  - Update to assert the new earlier-trip behavior (preferred), or
  - Migrate to test a per-branch inner guard (which still isolates), if the test was specifically exercising isolation.
- [ ] Specifically review:
  - [`guard-cost-fork.agency`](../../tests/agency/guards/guard-cost-fork.agency) — currently documents the "V1 limitation that mid-fork branches do NOT eagerly notify the outer guard." This plan removes that limitation; update the description and assertions.
  - [`guard-cost-race.agency`](../../tests/agency/guards/guard-cost-race.agency) and [`guard-cost-race-interrupts.agency`](../../tests/agency/guards/guard-cost-race-interrupts.agency) — race-mode propagation tests; the shared-guard mechanism may trip earlier in some scenarios.
  - [`guard-cost-fork-rejected-rolls-up.agency`](../../tests/agency/guards/guard-cost-fork-rejected-rolls-up.agency) — uses `getCost()` to verify deltas; should still pass since `localCost` + `propagateBranchCost` are unchanged.

### Task 7: Docs

- [ ] Update [`docs/site/guide/cost-guards.md`](../../docs/site/guide/cost-guards.md):
  - Replace the V1 limitation section with the new behavior: outer guards see real-time cost from all descendants.
  - Document the inner-guard-stays-local rule.
  - Add an example with a fork inside a guard showing mid-fork trip.
- [ ] Update [`docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md`](../../docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md):
  - New section: "Shared guard references." Explain `cloneForBranch` returning `this`, `inheritedGuardCount`, and the pause/resume re-link.

---

## Success criteria

- [ ] All existing `tests/agency/guards/*` tests pass after the migration (with assertions updated where behavior intentionally changed; see Task 6).
- [ ] Task 5 new E2E tests pass.
- [ ] `pnpm test:run` (full unit suite) passes.
- [ ] Manual smoke: run the motivating example (`guard($2.00) { fork(3 branches) { llm(...) } }`) with synthetic cost and verify trip fires mid-fork, before any branch reaches `propagateBranchCost`.

---

## Risks and how the design mitigates them

| Risk | Mitigation |
|---|---|
| Shared guard mutation race | Single-threaded JS event loop — `charge` is a simple `spent += amount`. No locks needed. |
| Double-charging on resume | Branch's `guards` array is filtered through `inheritedGuardCount` on serialize, so the parent-owned `OUTER` is serialized exactly once (on the parent's snapshot). On resume, re-prepended by reference, not deserialized as a separate copy. |
| Stale `AbortController` after resume | `CostGuard.resume(stack)` rebuilds the controller and re-composes into `stack.abortSignal`, identical to `TimeGuard`'s existing pattern. |
| Branch-pushed inner guards leaking to parent | They're pushed onto the branch's own stack AFTER seeding, so they sit at index `≥ inheritedGuardCount`. Serialization keeps them on the branch only. Never visible to the parent. |
| Double re-link if `runBatch` is re-entered multiple times in one execution | `BranchState.rehydrated` flag (live-only, not serialized) tracks whether we've already prepended. Reset on every new serialize boundary. |
| Pre-call gate refusing a call that would have succeeded | The pre-call check uses the same `g.check()` as post-call. If `g.check()` returns null, the call proceeds. There's no estimation — just "are we already over?" — so no false positives. |
