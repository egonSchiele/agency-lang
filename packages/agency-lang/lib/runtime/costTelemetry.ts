/**
 * Fire-and-forget usage telemetry from a subprocess to its parent, so
 * parent-side cost guards see child LLM spend live AND the parent's
 * per-invocation usage meter (the serve cost seam) accrues the child's full
 * cost/token/attribution breakdown (see
 * docs/superpowers/specs/2026-08-04-full-cost-token-breakdown-design.md).
 *
 * Deliberately dependency-light (the subprocessRunInfo.ts layering pattern):
 * the only runtime import is subprocessRunInfo; `NormalizedDelta` is a type-only
 * import (erased at runtime), so this stays a leaf module. The recordPaidUsage
 * sink calls the sender here on every accounted delta; stateStack / accounting
 * must not import ipc.ts.
 *
 * Never blocks and never throws: there is no reply, no listener, and a dead
 * channel is swallowed — the bootstrap disconnect watchdog is about to reap
 * this process anyway.
 */

import { isIpcMode, ipcChildDebug } from "./subprocessRunInfo.js";
import type { NormalizedDelta } from "./invocationUsage.js";

/** The UNTRUSTED wire shape a parent receives on `invocationUsage`. Every field
 *  is `unknown`: a version-skewed or malicious child may send anything, so the
 *  parent recovers it field-by-field via `normalizeIpcUsageDelta` before it
 *  reaches the accounting sink. The trusted SEND-side payload is a
 *  `NormalizedDelta` (this message minus `type`). */
export type IpcInvocationUsageMessage = {
  type: "invocationUsage";
  cost?: unknown;
  tokens?: unknown;
  unknownCostCallCount?: unknown;
  entry?: unknown;
  attributionLost?: unknown;
};

/** Relayed once when a process can no longer guarantee that all of its (or a
 *  descendant's) usage telemetry was delivered — makes the owning invocation's
 *  usage a trusted lower bound. Carries no cost. */
export type IpcInvocationUsageIncompleteMessage = {
  type: "invocationUsageIncomplete";
};

export type IpcUsageMessage =
  | IpcInvocationUsageMessage
  | IpcInvocationUsageIncompleteMessage;

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

/** A delta carries nothing worth relaying: no cost, no tokens, no unknown-cost
 *  call, no attribution entry, and no attribution loss. A no-op charge (e.g.
 *  `addCost(0)`) is skipped so it never spams the parent channel. */
function isNoOpDelta(delta: NormalizedDelta): boolean {
  if (delta.entry !== undefined) return false;
  if (delta.attributionLost) return false;
  if (delta.unknownCostCallCount !== 0) return false;
  if (delta.cost.totalCost !== 0) return false;
  const t = delta.tokens;
  return (
    t.inputTokens === 0 &&
    t.outputTokens === 0 &&
    t.cachedInputTokens === 0 &&
    t.cacheCreationInputTokens === 0 &&
    t.totalTokens === 0
  );
}

/** Relay a full normalized usage delta to the parent, once. Sends the complete
 *  nested breakdown (`cost`, `tokens`, `entry`, `unknownCostCallCount`,
 *  `attributionLost`). Skips an all-zero delta. */
export function sendInvocationUsageToParent(delta: NormalizedDelta): void {
  if (!canSend()) return;
  if (isNoOpDelta(delta)) return;
  trySend({ type: "invocationUsage", ...delta });
}

/** Relay the incompleteness marker to the parent, once. */
export function sendInvocationUsageIncompleteToParent(): void {
  if (!canSend()) return;
  trySend({ type: "invocationUsageIncomplete" });
}
