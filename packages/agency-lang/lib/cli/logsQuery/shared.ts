// What `agency logs traces`, `outline`, and `search` share: finding and
// reading the log, picking traces, and the line every command prints first.
// Each command is a function from parsed options to a `QueryResult`; only
// `register.ts` touches the process.
import * as path from "path";

import { chooseLog, type LiveSession, type LogDeps } from "@/cli/logsSession/target.js";
import { traceSummaries, type TraceSummary } from "@/logsViewer/traceSummaries.js";
import { buildForest } from "@/logsViewer/tree.js";
import type { TreeNode } from "@/logsViewer/types.js";
import { selectTraces, type TraceSelectionFlags } from "@/runDirectory/traceSelection.js";
import type { Trace } from "@/runDirectory/traces.js";

/** `outline` and `search` read the most recent trace when no flag picks. */
export const MOST_RECENT_ONLY = 1;

export type QueryResult = { text: string; json: unknown; exitCode: number };

/** One trace of an opened log: its root and its summary. The root is built
 *  from the trace's own events, as `session show` builds it, so every
 *  address a command prints is one `show` resolves. */
export type OpenedTrace = { traceId: string; root: TreeNode; summary: TraceSummary };

/** The log a query reads, found by `chooseLog`. The first line of every
 *  command's text names `logPath`. */
export type OpenedLog = {
  logPath: string;
  /** `logPath` relative to the current directory when it is inside it,
   *  so `runs/today/statelog.jsonl` and `log.jsonl` read apart. */
  shown: string;
  traces: OpenedTrace[];
};

export type QueryDeps = LogDeps & {
  /** The open viewers, probed as the session commands probe them, so a
   *  query reads the log the one open viewer has. A query never talks to
   *  the viewer itself. */
  probe(): Promise<LiveSession[]>;
  readLog(logPath: string): Trace[];
  now(): number;
};

export async function openQueryLog(
  log: string | undefined,
  deps: QueryDeps,
): Promise<OpenedLog | { refused: string }> {
  const choice = chooseLog(log, log === undefined ? await deps.probe() : [], deps);
  if (choice.kind === "refused") {
    return { refused: choice.reason };
  }
  const logPath =
    choice.kind === "session" ? path.resolve(choice.session.record.logPath) : choice.logPath;
  const traces = deps.readLog(logPath).map((trace): OpenedTrace => {
    const root = buildForest(trace.events)[0];
    return { traceId: trace.traceId, root, summary: traceSummaries([root], {})[0] };
  });
  const relative = path.relative(deps.cwd, logPath);
  const shown = relative.startsWith("..") || path.isAbsolute(relative) ? logPath : relative;
  return { logPath, shown, traces };
}

/** What a command works on once its log is open and its traces picked. */
export type PickedTraces = { log: OpenedLog; picked: OpenedTrace[]; older: number };

/**
 * Open the log, pick the traces, and hand them to `body`; a refusal from
 * either step is the command's answer. `keep` narrows the traces before
 * picking (`traces --errors`), so `--last` counts only the kept ones. Every
 * command's selection goes through here.
 */
export async function withPickedTraces(
  options: TraceSelectionFlags & { log?: string },
  pick: { defaultLast: number; keep?: (trace: OpenedTrace) => boolean },
  deps: QueryDeps,
  body: (picked: PickedTraces) => QueryResult,
): Promise<QueryResult> {
  const log = await openQueryLog(options.log, deps);
  if ("refused" in log) {
    return refusal(log.refused);
  }
  const pickable = log.traces
    .filter(pick.keep ?? (() => true))
    .map((trace) => ({ ...trace, startedAt: trace.summary.startedAt }));
  const selection = selectTraces(pickable, options, {
    defaultLast: pick.defaultLast,
    now: deps.now(),
  });
  if (selection.kind === "refused") {
    return refusal(selection.reason);
  }
  return body({ log, picked: selection.picked, older: selection.older });
}

/** The line every command prints first: the log it read, then the rest. */
export function logLine(log: OpenedLog, rest: string): string {
  return [log.shown, ...(rest === "" ? [] : [rest])].join(" · ");
}

export function refusal(reason: string): QueryResult {
  return { text: reason, json: { error: reason }, exitCode: 1 };
}

/** `1 trace`, `3 traces`; `plural` for a phrase that does not take an s. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** A trace's summary as JSON: times as ISO strings, absent facts as null. */
export function traceRecord(summary: TraceSummary): Record<string, unknown> {
  return {
    traceId: summary.traceId,
    startedAt: summary.startedAt === undefined ? null : new Date(summary.startedAt).toISOString(),
    workingMs: summary.durationMs ?? null,
    costUsd: summary.costUsd,
    tokens: summary.tokens,
    calls: summary.rounds,
    agentName: summary.agentName ?? null,
    hasError: summary.hasError,
    ask: summary.ask ?? null,
  };
}
