// The single accounting boundary for the serve cost seam.
//
// Every paid unit of work — an LLM completion (prompt.ts), an `addCost` charge
// (cost.ts; memory and image generation pay through it), and a subprocess's
// relayed usage (ipc.ts) — submits one `InvocationUsageDelta` here. This is the
// ONE place that (1) bills the branch's cost guards via `StateStack.billCharge`,
// (2) merges the invocation's usage meter, and (3) relays the full delta upward
// exactly once when this process is itself a subprocess. Because all three
// happen together, "authoritative cost" never depends on execution topology: the
// same charge counts identically in-process and in a child.

import { getRuntimeContext } from "./asyncContext.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";
import {
  completionUsageDelta,
  type InvocationAccountingTarget,
  type InvocationUsageDelta,
} from "./invocationUsage.js";
import {
  sendInvocationUsageToParent,
  sendInvocationUsageIncompleteToParent,
  sendModelAttributionIncompleteToParent,
} from "./costTelemetry.js";

/** Account one paid delta against an EXPLICIT target (out-of-frame callers such
 *  as the IPC telemetry handler pass `RunSession.ctx/stateStack`, never relying
 *  on AsyncLocalStorage). Bills guards, merges the meter, relays once. */
export function recordPaidUsageAt(
  target: InvocationAccountingTarget,
  delta: InvocationUsageDelta,
): void {
  target.stack.billCharge(delta.pricedCost);
  target.ctx.invocationUsage.merge(delta);
  sendInvocationUsageToParent(delta);
}

/** Ambient convenience for in-frame TS helpers (only `addCost`): reads the
 *  active `{ ctx, stack }` from the execution frame and delegates. */
export function recordPaidUsage(delta: InvocationUsageDelta): void {
  const { ctx, stack } = getRuntimeContext();
  recordPaidUsageAt({ ctx, stack }, delta);
}

/** Account one LLM completion through the paid-usage boundary (guards + meter +
 *  subprocess relay) and update the per-branch total-token accumulator that
 *  std::thread's getTokens() reports. Called from the prompt completion site. */
export function accountCompletionUsage(
  ctx: RuntimeContext<GraphState>,
  targetStack: StateStack,
  completion: {
    cost?: { totalCost?: number } | null;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  },
  model: string,
): void {
  recordPaidUsageAt(
    { ctx, stack: targetStack },
    completionUsageDelta({
      cost: completion.cost?.totalCost,
      inputTokens: completion.usage?.inputTokens,
      outputTokens: completion.usage?.outputTokens,
      model,
    }),
  );
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;
}

/** Record one UNKNOWN-cost provider attempt: a request that was dispatched to
 *  the provider but did not resolve to a priced completion (timeout / cancel /
 *  provider error after dispatch — possible spend, no price metadata). Adds one
 *  to unknownCostCallCount (no cost, no tokens) so pricingComplete goes false;
 *  relays upward once if this is a subprocess. A failure PROVEN before dispatch
 *  never calls this. */
export function recordUnknownCostAttempt(
  ctx: RuntimeContext<GraphState>,
  targetStack: StateStack,
): void {
  recordPaidUsageAt(
    { ctx, stack: targetStack },
    { pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 1 },
  );
}

/** Run one provider dispatch as a metered attempt (serve cost seam; each retry
 *  is a fresh attempt). A resolved dispatch is priced later at the completion
 *  site; a dispatched-but-UNRESOLVED attempt (timeout/cancel/provider error
 *  after dispatch — possible spend, no price) records one unknown-cost attempt
 *  so pricingComplete goes false. A pre-dispatch failure never enters here.
 *
 *  Returns the dispatch promise UNCHANGED (not wrapped in await/then): the
 *  unknown-cost record is a fire-and-forget side effect on rejection, so this
 *  adds no microtask tick to the caller's timing. That matters — race()
 *  determinism (which loser calls complete before the abort fires) is timing-
 *  sensitive, and wrapping the dispatch would shift it. */
export function meteredDispatch<T>(
  ctx: RuntimeContext<GraphState>,
  targetStack: StateStack,
  dispatch: () => Promise<T>,
): Promise<T> {
  const pending = dispatch();
  void pending.catch(() => recordUnknownCostAttempt(ctx, targetStack));
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

/** Mark this invocation's model attribution as no longer trustworthy (a
 *  measurable child charge arrived with no attribution — a version-skewed
 *  child). Relays the marker upward once, only on the first transition, so a
 *  mid-tier process forwards a descendant's degraded attribution without
 *  spamming. */
export function markModelAttributionIncompleteAt(ctx: RuntimeContext<GraphState>): void {
  if (ctx.invocationUsage.markModelAttributionIncomplete()) {
    sendModelAttributionIncompleteToParent();
  }
}
