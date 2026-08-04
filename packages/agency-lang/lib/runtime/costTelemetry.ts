/**
 * Fire-and-forget usage telemetry from a subprocess to its parent, so
 * parent-side cost guards see child LLM spend live AND the parent's
 * per-invocation usage meter (the serve cost seam) accrues the child's
 * cost/tokens/unknown-count (see
 * docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md).
 *
 * Deliberately dependency-light (the subprocessRunInfo.ts layering pattern):
 * the only runtime import is subprocessRunInfo; `InvocationUsageDelta` is a
 * type-only import (erased at runtime), so this stays a leaf module.
 * `recordPaidUsageAt` calls the sender here on every paid charge; stateStack /
 * accounting must not import ipc.ts.
 *
 * Never blocks and never throws: there is no reply, no listener, and a dead
 * channel is swallowed — the bootstrap disconnect watchdog is about to reap
 * this process anyway.
 */

import { isIpcMode, ipcChildDebug } from "./subprocessRunInfo.js";
import type { InvocationUsageDelta, UsageAttribution } from "./invocationUsage.js";

/** Legacy cost-only telemetry message. No longer emitted by this codebase (the
 *  full-delta message below supersedes it), but still ACCEPTED on receive so a
 *  version-skewed child cannot silently drop cost. */
export type IpcTelemetryMessage = {
  type: "telemetry";
  costUsd: number;
};

/** Full per-invocation usage delta relayed to the parent. A legal delta may
 *  carry zero priced cost with nonzero tokens and/or one unknown-cost call (an
 *  unpriced completion). `attribution` rides along so the parent can bucket the
 *  charge per model; its ABSENCE on a measurable message means an older child
 *  lost the model (the parent flags `modelAttributionComplete`). */
export type IpcInvocationUsageMessage = {
  type: "invocationUsage";
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  attribution?: UsageAttribution;
};

/** Relayed once when a process can no longer guarantee that all of its (or a
 *  descendant's) usage telemetry was delivered — makes the owning invocation's
 *  usage a trusted lower bound. Carries no cost. */
export type IpcInvocationUsageIncompleteMessage = {
  type: "invocationUsageIncomplete";
};

/** Relayed once when a process booked priced spend to `unattributed` because a
 *  descendant lost the charge's model (a version-skewed child) — flags the
 *  owning invocation's `modelAttributionComplete` false. Carries no cost. */
export type IpcModelAttributionIncompleteMessage = {
  type: "modelAttributionIncomplete";
};

export type IpcUsageMessage =
  | IpcTelemetryMessage
  | IpcInvocationUsageMessage
  | IpcInvocationUsageIncompleteMessage
  | IpcModelAttributionIncompleteMessage;

/** The wire contract for a legacy billable cost: a positive finite number.
 *  Used only when normalizing a legacy `{ costUsd }` message on receive. */
export function isPayableCost(costUsd: unknown): costUsd is number {
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0;
}

function canSend(): boolean {
  return isIpcMode() && typeof process.send === "function";
}

function trySend(msg: IpcUsageMessage): void {
  try {
    (process.send as (m: unknown) => boolean)(msg);
  } catch (err) {
    // Channel gone — parent died; the watchdog will exit this process.
    // Swallowed (fire-and-forget invariant), but traceable via the shared
    // child-debug logger (ipcLog is unreachable from this leaf module).
    const detail = err instanceof Error ? err.message : String(err);
    ipcChildDebug(`send telemetry_send_failed ${detail}`);
  }
}

/** Relay a full usage delta to the parent, once. Skips an all-zero delta (a
 *  no-op charge carries nothing worth relaying). */
export function sendInvocationUsageToParent(delta: InvocationUsageDelta): void {
  if (!canSend()) return;
  if (
    delta.pricedCost === 0 &&
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.unknownCostCallCount === 0
  ) {
    return;
  }
  trySend({ type: "invocationUsage", ...delta });
}

/** Relay the incompleteness marker to the parent, once. */
export function sendInvocationUsageIncompleteToParent(): void {
  if (!canSend()) return;
  trySend({ type: "invocationUsageIncomplete" });
}

/** Relay the model-attribution-incomplete marker to the parent, once. */
export function sendModelAttributionIncompleteToParent(): void {
  if (!canSend()) return;
  trySend({ type: "modelAttributionIncomplete" });
}
