/**
 * Fire-and-forget cost telemetry from a subprocess to its parent, so
 * parent-side cost guards see child LLM spend live (see
 * docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md).
 *
 * Deliberately dependency-light (the subprocessRunInfo.ts layering
 * pattern — the only import IS subprocessRunInfo, itself dependency-free):
 * `StateStack.billCharge` calls this on every paid charge, and stateStack
 * must not import ipc.ts.
 *
 * Never blocks and never throws: there is no reply, no listener, and a
 * dead channel is swallowed — the bootstrap disconnect watchdog is about
 * to reap this process anyway.
 */

import { isIpcMode } from "./subprocessRunInfo.js";

export type IpcTelemetryMessage = {
  type: "telemetry";
  costUsd: number;
};

/** The wire contract for a billable cost: a positive finite number.
 * Shared by the sender and the parent-side handler so both ends of the
 * channel enforce the same rule (the receiving side matters more — the
 * child is the less-trusted party). */
export function isPayableCost(costUsd: unknown): costUsd is number {
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0;
}

export function sendCostTelemetryToParent(costUsd: number): void {
  if (!isIpcMode() || typeof process.send !== "function") return;
  if (!isPayableCost(costUsd)) return;
  const msg: IpcTelemetryMessage = { type: "telemetry", costUsd };
  try {
    process.send(msg);
  } catch (err) {
    // Channel gone — parent died; the watchdog will exit this process.
    // Deliberately swallowed (fire-and-forget invariant), but traceable:
    // ipcLog is unreachable from this leaf module, so mirror its line
    // format (this sender only ever runs in a child) and env gating.
    if (process.env.AGENCY_IPC_DEBUG === "1") {
      const ts = new Date().toISOString().slice(11, 23);
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ipc:child] ${ts} send telemetry_send_failed ${detail}\n`);
    }
  }
}
