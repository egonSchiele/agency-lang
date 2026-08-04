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
): void {
  recordPaidUsageAt(
    { ctx, stack: targetStack },
    completionUsageDelta({
      cost: completion.cost?.totalCost,
      inputTokens: completion.usage?.inputTokens,
      outputTokens: completion.usage?.outputTokens,
    }),
  );
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;
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
