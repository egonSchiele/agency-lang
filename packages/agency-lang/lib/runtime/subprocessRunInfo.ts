/**
 * Per-PROCESS subprocess run info, seeded by the bootstrap from the parent's
 * run/resume instruction before the compiled module is imported.
 *
 * A subprocess executes exactly one run per process, so module scope is the
 * correct lifetime here (the same arrangement as the bootstrap's
 * ipcPayloadLimit). This lives in its own dependency-free module so both
 * `ipc.ts` and `state/context.ts` / `node.ts` can read it without import
 * cycles.
 */

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

/** Emit one child-side IPC debug line to stderr, gated on AGENCY_IPC_DEBUG=1.
 * Lives here (the dependency-free leaf) so both callbackForwarding.ts and
 * costTelemetry.ts share one implementation; ipcLog (ipc.ts) is unreachable from
 * these leaves without violating the layering rule. */
export function ipcChildDebug(line: string): void {
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
