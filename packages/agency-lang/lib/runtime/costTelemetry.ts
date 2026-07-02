/**
 * Fire-and-forget cost telemetry from a subprocess to its parent, so
 * parent-side cost guards see child LLM spend live (see
 * docs/superpowers/specs/2026-07-02-subprocess-cost-telemetry-design.md).
 *
 * Deliberately dependency-free (the subprocessRunInfo.ts layering
 * pattern): `StateStack.chargeGuards` calls this on every paid charge,
 * and stateStack must not import ipc.ts. The message type lives here and
 * is re-exported by ipc.ts into the SubprocessToParent union.
 *
 * Never blocks and never throws: there is no reply, no listener, and a
 * dead channel is swallowed — the bootstrap disconnect watchdog is about
 * to reap this process anyway.
 */

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
  if (process.env.AGENCY_IPC !== "1" || typeof process.send !== "function") return;
  if (!isPayableCost(costUsd)) return;
  const msg: IpcTelemetryMessage = { type: "telemetry", costUsd };
  try {
    process.send(msg);
  } catch (err) {
    // Channel gone — parent died; the watchdog will exit this process.
    // Deliberately swallowed (fire-and-forget invariant), but traceable:
    // ipcLog is unreachable from this leaf module, so mirror its gating.
    if (process.env.AGENCY_IPC_DEBUG === "1") {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ipc:telemetry] send failed: ${detail}\n`);
    }
  }
}
