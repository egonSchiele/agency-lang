# Review v2: Orphaned tool_use Repair plan — execute-readiness re-check

Reviewer: Claude, 2026-07-23
Plan: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-22-orphaned-tool-use-repair.md`
Context: the plan's line references were verified 2026-07-22; since then #651 (queueMessage), #653 (reviver), and #655 (hoistCalls + resume tripwire) merged, all touching neighboring code. This pass re-verified the plan against current main (135de584c). Everything below was checked by grep/read on that commit.

## Verdict: good to execute

Every dependency and anchor holds on current main:

- The turn-budget machinery Tasks 5 and 7 lean on is present: `turnBudgetHandler` at `budget.agency:136` with the exact opening check the plan quotes at :143, `TURN_BUDGET_LABEL` at :31, and both referenced fixtures (`turn-budget-partial.agency`, `finalize-binder-returns-draft.agency`) exist.
- `runner.ts:706` (`this.frame.locals[threadKey] = tid;`) and the `:792` un-awaited statelog precedent are byte-exact.
- The Task 6 count is still exactly 14 unlabeled `guard(` sites.
- `threadRepair.test.ts` has the `asst`/`tool`/`roles` builders; `statelogClient.threadResumed` is at :1199; `runner.test.ts` has `makeMockCtx` imported and `makeFrame` defined; `interrupt("confirm")` has fixture precedent (`tag-interrupt.agency:11`); the `messageLabels` doc sentence Task 1 edits exists verbatim at `messageThread.ts:82`.
- #655 does not interfere: `runner.ts` was untouched by it (claims live in generated preambles, not the Runner), the new fixture's shapes pass through the hoist pass cleanly (guard blocks desugar before hoisting; a named `with turnBudgetHandler` has no inline handler body slot), and the Task 4 unit tests use unstamped frames the tripwire never checks.

## Two line-number drifts (cosmetic, within the plan's own "~" tolerance)

- The prompt.ts restore block is now at :1052 (plan says ~1041-1052) — #653/#655 added a few lines above it.
- The `markThreadCancelled` caller is now at :1984 (plan says :2001).

The plan's closing note ("if anything contradicts what you find, stop and re-read") covers both.

## One recommended addition: statelog emit on the restore refusal (Task 5)

`restoreThreadForResume` refuses a stale checkpoint by throwing. In this runtime a throw converts to a Failure at the next def boundary, and Failures get laundered — `failOpenFeedback` turning a reviver crash into a review PASS is the incident that proved it, and it is why #655's `claimFrameForScope` emits a statelog `runtimeError` before its own throw. The refusal here is the same class of must-be-findable event. Suggest mirroring that pattern: one best-effort emit via `agencyStore.getStore()?.ctx?.statelogClient?.error?.(...)` before the throw, with the same laundering rationale in the comment. A few lines, and the Task 5 tests need no change (the throw still fires).

## Two notes, no action required

- **Serialization asymmetry, deliberate on both sides:** this plan serializes `repairs` only when > 0 with legacy snapshots reviving as 0 and being refused post-repair (documented in its Decisions section); #655 serializes `scopeName` always, under the no-back-compat ruling. Different fields, both choices written down. Noting it so nobody later "harmonizes" one into the other without reading both rationales.
- **Coordination with the callback-injection spec:** the injection design adds turn-scoped queued messages that must be dropped at the reopen-repair seam. This plan lands first, so per the standing agreement the injection work adds that drain to `repairAbandonedTurn` when it lands — nothing to do here beyond remembering it.
