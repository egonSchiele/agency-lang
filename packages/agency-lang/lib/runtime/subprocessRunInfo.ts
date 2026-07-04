/**
 * Per-PROCESS subprocess run info, seeded by the bootstrap from the parent's
 * run/resume instruction before the compiled module is imported.
 *
 * A subprocess executes exactly one run per process, so module scope is the
 * correct lifetime here (the same arrangement as the bootstrap's
 * ipcPayloadLimit). Kept intentionally minimal so both `ipc.ts` and
 * `state/context.ts` / `node.ts` can read it without import cycles. Its only
 * runtime import is `asyncContext` (for `ipcChildDebug`'s best-effort statelog
 * emission); that edge is cycle-safe because asyncContext's value-chain
 * (bootstrapThreadStore -> threadStore -> statelogClient / messageThread) never
 * imports back into this module, ipc.ts, or the leaf senders.
 */

import { agencyStore } from "./asyncContext.js";

export type SubprocessRunInfo = {
  /** The parent's runId — the child adopts it instead of minting its own,
   * so child statelog events land in the same trace (runId persists across
   * pause/resume cycles, matching the in-process convention). */
  runId?: string;
  /** Stable id for one logical child run, shared by every segment across
   * pause/resume cycles; distinguishes concurrent subprocesses within one
   * parent runId. */
  subprocessSessionId?: string;
  /** The parent's `subprocessRun` span id — the child's statelog client
   * adopts it as an external root so child spans nest under the parent's
   * span tree. */
  parentSpanId?: string;
  /** Nesting depth of this process: 0 = root (not a subprocess). */
  depth: number;
  /** The tightest maxDepth cap along the ancestor chain — a child's own
   * run() calls can never exceed an ancestor's cap. */
  maxDepth?: number;
};

/** Whether this process is a forked Agency subprocess (AGENCY_IPC=1 is set
 * by `buildForkOptions` before every fork). The single source of truth for
 * the mode signal — ipc.ts and the telemetry leaf both read it from here. */
export function isIpcMode(): boolean {
  return process.env.AGENCY_IPC === "1";
}

/** Emit one child-side IPC diagnostic. Shared by callbackForwarding.ts and
 * costTelemetry.ts (ipcLog in ipc.ts is unreachable from these leaves without
 * violating the layering rule). Two independent sinks:
 *   - statelog `debug` event (best-effort) so the diagnostic is visible in the
 *     trace when observability is on — resolved from the active ALS frame's
 *     ctx.statelogClient; no-ops with no frame/client, never throws;
 *   - stderr, gated on AGENCY_IPC_DEBUG=1, for local IPC debugging. */
export function ipcChildDebug(line: string): void {
  const client = agencyStore.getStore()?.ctx?.statelogClient;
  if (client) {
    try {
      // Fire-and-forget; a failed statelog post must never affect the run. The
      // real client.debug is async (rejection handled by .catch); the try guards
      // the defensive case of a synchronous throw. Intentionally swallowed — this
      // IS the diagnostic sink, so there is nowhere else to surface an error.
      void Promise.resolve(client.debug(`[ipc:child] ${line}`, {})).catch(() => {});
    } catch {
      // no-op: statelog diagnostics are best-effort
    }
  }
  if (process.env.AGENCY_IPC_DEBUG !== "1") return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[ipc:child] ${ts} ${line}\n`);
}

let info: SubprocessRunInfo = { depth: 0 };

export function setSubprocessRunInfo(next: SubprocessRunInfo): void {
  info = next;
}

export function getSubprocessRunInfo(): SubprocessRunInfo {
  return info;
}
