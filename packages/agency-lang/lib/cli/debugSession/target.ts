// The one place that decides which program a `debug session` command
// acts on: the pid given with `--pid`, else the one run the CLI holds a
// session on. Takes the records and what probing them said, returns a
// plain value; the commands never look at flags.
import type { AttachRecord } from "@/debugger/attach/registry.js";
import type { StatusMessage } from "@/debugger/attach/protocol.js";

/** A registered program and what its socket said, or null when it has
 *  no socket open (no session) or did not answer. */
export type ProbedProgram = { record: AttachRecord; status: StatusMessage | null };

export type Target =
  { kind: "program"; record: AttachRecord } | { kind: "refused"; reason: string };

export function resolveTarget(
  pid: number | undefined,
  probed: readonly ProbedProgram[],
  checked: (pid: number) => AttachRecord | { refused: string },
): Target {
  if (pid !== undefined) {
    const record = checked(pid);
    return "refused" in record
      ? { kind: "refused", reason: record.refused }
      : { kind: "program", record };
  }
  const held = probed.filter(
    (entry) => entry.status?.cli !== null && entry.status?.cli !== undefined,
  );
  if (held.length === 1) {
    return { kind: "program", record: held[0]!.record };
  }
  if (held.length === 0) {
    return {
      kind: "refused",
      reason:
        probed.length === 0
          ? "no Agency program is registered for attach; `agency debug session list` shows the runs that are"
          : "no run holds a session; `agency debug session attach <pid>` opens one (`list` shows the pids)",
    };
  }
  const pids = held.map((entry) => entry.record.pid).join(", ");
  return { kind: "refused", reason: `sessions are held on pids ${pids}; say which with --pid` };
}

/** The SESSION column of `list`. */
export function sessionWords(status: StatusMessage | null, now: number): string {
  if (status === null) {
    return "none";
  }
  const parts: string[] = [];
  if (status.terminal) {
    parts.push("terminal");
  }
  if (status.cli !== null) {
    const since =
      status.cli.lastVisit === null
        ? status.cli.visiting
          ? "visiting"
          : "held"
        : `held, last visit ${ago(now - status.cli.lastVisit)} ago`;
    parts.push(since);
  }
  return parts.length === 0 ? "none" : parts.join(" + ");
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60 === 0 ? "" : `${seconds % 60}s`}`;
}
