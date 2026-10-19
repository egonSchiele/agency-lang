// The `agency logs session` commands, each a function of a Target (from
// target.ts) and its own arguments, returning what to print. None of them
// looks at a flag or a registry record; that was done by resolveTarget.
import { formatAddress, splitAddress } from "@/logsViewer/address.js";
import { expandRow, unresolvedCommentText, type ExpandedRow } from "@/logsViewer/rowText.js";
import { findRow } from "@/logsViewer/detailTarget.js";
import { anchorFor } from "@/logsViewer/marks.js";
import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import type { SessionReply, SessionRequest } from "@/logsViewer/session/protocol.js";
import { buildForest } from "@/logsViewer/tree.js";
import type { TreeNode } from "@/logsViewer/types.js";
import { threadsForTrace, type Comment, type CommentThread } from "@/runDirectory/comments.js";
import { matchTrace, matchTraceId, readTraces, type Trace } from "@/runDirectory/traces.js";

import type { Target } from "./target.js";

export type CommandResult = { text: string; json: unknown; exitCode: number };

export type CommandDeps = {
  readLog(logPath: string): Trace[];
  request(socketPath: string, req: SessionRequest): Promise<SessionReply>;
};

export const defaultCommandDeps = (request: CommandDeps["request"]): CommandDeps => ({
  readLog: (logPath) => readTraces(logPath).traces,
  request,
});

const NO_VIEWER =
  "no viewer is open; get and navigate need one (open it with `agency logs <file>`)";

function refused(reason: string): CommandResult {
  return { text: reason, json: { error: reason }, exitCode: 1 };
}

/** `list`: every record, with its state. Not a function of a target. */
export function list(probed: readonly ProbedRecord[]): CommandResult {
  if (probed.length === 0) {
    return { text: "no viewers are open", json: [], exitCode: 0 };
  }
  const rows = probed.map((entry) => {
    const where =
      entry.result.state === "live"
        ? formatAddress(entry.result.focus.traceId, entry.result.focus.rowId ?? "")
        : entry.result.state;
    return {
      pid: entry.record.pid,
      logPath: entry.record.logPath,
      state: entry.result.state,
      where,
    };
  });
  const text = rows
    .map((row) => `${row.pid}\t${row.state.padEnd(14)}\t${row.logPath}\t${row.where}`)
    .join("\n");
  return { text, json: rows, exitCode: 0 };
}

/** `get`: the row under the viewer's cursor, expanded. */
export function get(target: Target, deps: CommandDeps): CommandResult {
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  if (target.kind === "files") {
    return refused(NO_VIEWER);
  }
  const { focus } = target.session;
  if (focus.rowId === undefined) {
    const text = `${focus.traceId}/ (on the ${focus.screen} screen, no row focused)`;
    return { text, json: { traceId: focus.traceId, screen: focus.screen }, exitCode: 0 };
  }
  return showRow(target, openLog(target, deps), focus.traceId, focus.rowId);
}

/** `show <row>`: one row, expanded, with its comments. */
export function show(target: Target, deps: CommandDeps): CommandResult {
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  const log = openLog(target, deps);
  const located = locate(target, log);
  if ("error" in located) {
    return refused(located.error);
  }
  return showRow(target, log, located.traceId, located.rowId);
}

/** `comments`: every comment on the target's trace (or every trace), each
 *  with its row expanded, or listed by its anchor when the row is gone. */
export function comments(target: Target, all: boolean, deps: CommandDeps): CommandResult {
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  const store = target.store;
  if (store === undefined) {
    return refused("this viewer has no comments file");
  }
  const folded = store.read();
  // With no viewer there is no current trace to prefer: show them all.
  const everyTrace = all || target.traceId === undefined;
  const log = openLog(target, deps);
  const traceId =
    everyTrace || target.traceId === undefined
      ? undefined
      : resolveTraceId(log.traces, target.traceId);
  if (traceId !== undefined && "error" in traceId) {
    return refused(traceId.error);
  }
  const threads = traceId === undefined ? folded.threads : threadsForTrace(folded, traceId.id);
  const blocks = threads.map((thread) => {
    const trace = log.forest(thread.comment.traceId);
    const expanded =
      trace === undefined ? undefined : expandRow(trace, thread.comment.rowId, [thread]);
    return {
      thread,
      text: expanded?.text ?? unresolvedCommentText(thread),
      row: expanded?.json ?? null,
    };
  });
  const text = blocks.length === 0 ? "no comments" : blocks.map((block) => block.text).join("\n\n");
  return {
    text,
    json: blocks.map((block) => ({
      ...block.thread,
      resolved: block.row !== null,
      row: block.row,
    })),
    exitCode: 0,
  };
}

/** `comment add <row> <text>`: write through the target's store, then tell
 *  an open viewer to re-read. */
export async function commentAdd(
  target: Target,
  text: string,
  options: { replyTo?: string },
  deps: CommandDeps,
): Promise<CommandResult> {
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  if (target.store === undefined) {
    return refused("this viewer has no comments file");
  }
  const log = openLog(target, deps);
  const located = locate(target, log);
  if ("error" in located) {
    return refused(located.error);
  }
  const trace = log.forest(located.traceId);
  const row = trace === undefined ? undefined : findRow(trace, located.rowId);
  if (row === undefined) {
    return refused(`no row ${located.rowId} in trace ${located.traceId}`);
  }
  if (options.replyTo !== undefined) {
    const parent = commentById(target.store.read().threads, options.replyTo);
    if (parent === undefined) {
      return refused(`no comment ${options.replyTo} to reply to`);
    }
    if (parent.traceId !== located.traceId || parent.rowId !== located.rowId) {
      return refused(
        `comment ${options.replyTo} is on ${formatAddress(parent.traceId, parent.rowId)}, not on this row`,
      );
    }
  }
  const written: Comment = target.store.add({
    traceId: located.traceId,
    rowId: located.rowId,
    anchor: anchorFor(row),
    text,
    replyTo: options.replyTo,
  });
  const saved = `saved ${written.id} on ${formatAddress(written.traceId, written.rowId)}`;
  if (target.kind === "session") {
    // The comment is on disk either way: a viewer that quit or stalled
    // between the probe and now must not turn the write into a failure.
    try {
      await deps.request(target.session.socketPath, { op: "reload" });
    } catch (error) {
      return {
        text: `${saved}; the viewer did not reload (${(error as Error).message})`,
        json: { ...written, viewerReloaded: false },
        exitCode: 0,
      };
    }
  }
  return { text: saved, json: written, exitCode: 0 };
}

/** `navigate <row>`: move the open viewer's cursor. The argument may also be
 *  a trace id (or unique prefix) alone, which opens that trace on its first
 *  row. */
export async function navigate(target: Target, deps: CommandDeps): Promise<CommandResult> {
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  if (target.kind === "files") {
    return refused(NO_VIEWER);
  }
  const log = openLog(target, deps);
  const traceOnly =
    target.rowRef === undefined || target.rowRef.includes("/")
      ? undefined
      : matchTraceId(
          log.traces.map((trace) => trace.traceId),
          target.rowRef,
        );
  const located: { traceId: string; rowId: string | undefined } | { error: string } =
    traceOnly?.kind === "one" ? { traceId: traceOnly.id, rowId: undefined } : locate(target, log);
  if ("error" in located) {
    return refused(located.error);
  }
  const reply = await deps.request(target.session.socketPath, {
    op: "navigate",
    traceId: located.traceId,
    rowId: located.rowId,
  });
  if (!reply.ok) {
    return refused(reply.error);
  }
  const address =
    located.rowId === undefined ? located.traceId : formatAddress(located.traceId, located.rowId);
  return { text: `viewer moved to ${address}`, json: { address }, exitCode: 0 };
}

/** `pick`: open the viewer's list of traces. */
export async function pick(target: Target, deps: CommandDeps): Promise<CommandResult> {
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  if (target.kind === "files") {
    return refused(NO_VIEWER);
  }
  const reply = await deps.request(target.session.socketPath, { op: "pick" });
  if (!reply.ok) {
    return refused(reply.error);
  }
  return { text: "viewer is on the list of traces", json: { picking: true }, exitCode: 0 };
}

// --- shared steps -----------------------------------------------------------

type Located = { traceId: string; rowId: string } | { error: string };

/** The log a command works on, read once, with each trace's forest built
 *  once however many comments sit on it. */
type OpenLog = { traces: Trace[]; forest(traceId: string): TreeNode | undefined };

function openLog(target: Exclude<Target, { kind: "refused" }>, deps: CommandDeps): OpenLog {
  const traces = deps.readLog(logPathOf(target));
  const forests: Record<string, TreeNode | undefined> = Object.create(null);
  return {
    traces,
    forest: (traceId) => {
      if (!(traceId in forests)) {
        const trace = traces.find((candidate) => candidate.traceId === traceId);
        forests[traceId] = trace === undefined ? undefined : buildForest(trace.events)[0];
      }
      return forests[traceId];
    },
  };
}

/** The trace and row a command acts on: the row argument, with its trace
 *  from the address, the flag, or the viewer, resolved against the log. */
function locate(target: Exclude<Target, { kind: "refused" }>, log: OpenLog): Located {
  if (target.rowRef === undefined) {
    return { error: "say which row: an address <trace id>/<row id>, or a row id with --trace" };
  }
  const traces = log.traces;
  const address = splitAddress(
    target.rowRef,
    traces.map((trace) => trace.traceId),
  );
  if (address !== undefined) {
    return address;
  }
  if (target.traceId === undefined) {
    return {
      error: `a bare row id needs a trace: pass --trace <id>, or use an address. Traces in the log: ${traces
        .map((trace) => trace.traceId)
        .join(", ")}`,
    };
  }
  const resolved = resolveTraceId(traces, target.traceId);
  if ("error" in resolved) {
    return resolved;
  }
  return { traceId: resolved.id, rowId: target.rowRef };
}

function resolveTraceId(traces: Trace[], idOrPrefix: string): { id: string } | { error: string } {
  const match = matchTrace(traces, idOrPrefix);
  if (match.kind === "one") {
    return { id: match.trace.traceId };
  }
  if (match.kind === "ambiguous") {
    return { error: `trace ${idOrPrefix} is ambiguous: ${match.ids.join(", ")}` };
  }
  return {
    error: `no trace ${idOrPrefix} in the log (found: ${traces.map((trace) => trace.traceId).join(", ") || "none"})`,
  };
}

function showRow(
  target: Exclude<Target, { kind: "refused" }>,
  log: OpenLog,
  traceId: string,
  rowId: string,
): CommandResult {
  const trace = log.forest(traceId);
  if (trace === undefined) {
    return refused(`no trace ${traceId} in ${logPathOf(target)}`);
  }
  const threads = threadsOnRow(target, traceId, rowId);
  const expanded: ExpandedRow | undefined = expandRow(trace, rowId, threads);
  if (expanded === undefined) {
    return refused(`no row ${rowId} in trace ${traceId}`);
  }
  return { text: expanded.text, json: expanded.json, exitCode: 0 };
}

function threadsOnRow(
  target: Exclude<Target, { kind: "refused" }>,
  traceId: string,
  rowId: string,
): CommentThread[] {
  if (target.store === undefined) {
    return [];
  }
  return threadsForTrace(target.store.read(), traceId).filter(
    (thread) => thread.comment.rowId === rowId,
  );
}

function commentById(threads: readonly CommentThread[], id: string): Comment | undefined {
  return threads
    .flatMap((thread) => [thread.comment, ...thread.replies])
    .find((comment) => comment.id === id);
}

function logPathOf(target: Exclude<Target, { kind: "refused" }>): string {
  return target.kind === "session" ? target.session.record.logPath : target.logPath;
}
