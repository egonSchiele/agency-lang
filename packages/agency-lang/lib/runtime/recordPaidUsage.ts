// The single accounting boundary for the serve cost seam.
//
// Every paid unit of work — an LLM completion/embedding/image (prompt.ts,
// memory/manager.ts, stdlib/image.ts), an `addCost` charge (cost.ts), and a
// subprocess's relayed usage (ipc.ts) — becomes one domain observation or one
// already-recovered IPC delta that flows through this ONE synchronous sink. The
// sink (1) bills the branch's cost guards via `StateStack.billCharge`, (2)
// merges the invocation's usage meter, (3) degrades `usageComplete` when this
// delta lost attribution, and (4) relays the delta upward — then, after it, one
// incompleteness marker on the first meter transition — when this process is
// itself a subprocess. Because all four happen together, "authoritative cost"
// never depends on execution topology: the same charge counts identically
// in-process and in a child.

import type { PromptResult } from "smoltalk";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";
import {
  normalizeObservation,
  type NormalizedDelta,
  type ProviderUsageKind,
  type UsageObservation,
} from "./invocationUsage.js";
import {
  sendInvocationUsageToParent,
  sendInvocationUsageIncompleteToParent,
} from "./costTelemetry.js";

type AccountingTarget = {
  ctx: RuntimeContext<GraphState>;
  stack: StateStack;
};

/** THE accounting sink — private to this module. Bills the branch, merges the
 *  meter once, and degrades `usageComplete` when the delta lost attribution. It
 *  then relays the normalized delta upward and, only when a meter transition
 *  actually happened (a first count-overflow inside `merge`, or the
 *  attribution-loss `markIncomplete`), relays ONE incompleteness marker AFTER
 *  the delta. FIFO therefore preserves the recovered money before degrading the
 *  ancestor, and the marker is never sent twice for the same transition. */
function recordUsageDelta(target: AccountingTarget, delta: NormalizedDelta): void {
  target.stack.billCharge(delta.cost.totalCost);
  const overflowTransition = target.ctx.invocationUsage.merge(delta);
  const attributionTransition = delta.attributionLost
    ? target.ctx.invocationUsage.markIncomplete()
    : false;
  sendInvocationUsageToParent(delta);
  if (overflowTransition || attributionTransition) {
    sendInvocationUsageIncompleteToParent();
  }
}

/** Record one domain observation (a provider outcome or a manual charge) against
 *  an explicit branch target. Normalizes exactly once, then submits to the sink. */
export function recordUsage(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  observation: UsageObservation,
): void {
  recordUsageDelta({ ctx, stack }, normalizeObservation(observation));
}

/** Account one LLM completion (the prompt completion site) as a provider
 *  observation AND update the per-branch total-token accumulator that
 *  std::thread's getTokens() reports. The branch-local update is a compatibility
 *  side effect kept deliberately out of the general sink. */
export function recordCompletionUsage(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  completion: Pick<PromptResult, "model" | "cost" | "usage">,
  configuredModel: string | null | undefined,
): void {
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "completion",
    reportedModel: completion.model,
    configuredModel,
    cost: completion.cost,
    tokens: completion.usage,
  });
  stack.localTokens += completion.usage?.totalTokens ?? 0;
}

/** Record one UNRESOLVED provider attempt: a request that was dispatched to the
 *  provider but never resolved to a priced result (timeout / cancel / a
 *  post-dispatch provider error — possible spend, no price metadata). Adds one
 *  to `unknownCostCallCount` (no cost, no tokens) so `pricingComplete` goes
 *  false. A failure PROVEN before dispatch never calls this. */
export function recordUnresolvedAttempt(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  kind: ProviderUsageKind,
): void {
  recordUsage(ctx, stack, { type: "attempt", kind });
}

/** The narrow IPC entry point into the sink. The delta was ALREADY recovered by
 *  `normalizeIpcUsageDelta`, so this must not normalize again and must not
 *  enforce guards (the IPC handler enforces live-session guards afterward). */
export function recordNormalizedUsageDelta(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  delta: NormalizedDelta,
): void {
  recordUsageDelta({ ctx, stack }, delta);
}

/** Run one provider dispatch as a metered attempt (serve cost seam; each retry
 *  is a fresh attempt). A resolved dispatch is priced later at its completion
 *  site; a dispatched-but-UNRESOLVED attempt records one unresolved attempt so
 *  `pricingComplete` goes false. A pre-dispatch failure never enters here.
 *
 *  Returns the dispatch promise UNCHANGED (not wrapped in await/then): the
 *  attempt record is a fire-and-forget side effect on rejection, so this adds no
 *  microtask tick to the caller's timing. That matters — race() determinism
 *  (which loser calls complete before the abort fires) is timing-sensitive, and
 *  wrapping the dispatch would shift it. */
export function meteredDispatch<T>(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  kind: ProviderUsageKind,
  dispatch: () => Promise<T>,
): Promise<T> {
  const pending = dispatch();
  void pending.catch(() => recordUnresolvedAttempt(ctx, stack, kind));
  return pending;
}

/** Mark this invocation's usage as no longer guaranteed complete (an abnormal
 *  subprocess termination). Relays the marker upward once, only on the first
 *  transition, so a mid-tier process forwards a descendant's incompleteness
 *  without spamming. */
export function markInvocationUsageIncompleteAt(ctx: RuntimeContext<GraphState>): void {
  if (ctx.invocationUsage.markIncomplete()) {
    sendInvocationUsageIncompleteToParent();
  }
}
