// What `agency logs traces`, `outline`, and `search` share: opening the
// log, picking traces, and the line every command prints first. Each
// command is a function from parsed options to a `QueryResult`; only
// `register.ts` touches the process. Which log a command reads, and how its
// bytes are read, is the caller's: `QueryDeps.loadLog`.
import * as path from "path";

import { TOOL_TROUBLE, traceSummaries, type TraceSummary } from "@/logsViewer/traceSummaries.js";
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

/** The log a query reads. The first line of every command's text names
 *  `logPath`. */
export type OpenedLog = {
  logPath: string;
  /** `logPath` relative to the current directory when it is inside it,
   *  so `runs/today/statelog.jsonl` and `log.jsonl` read apart. */
  shown: string;
  traces: OpenedTrace[];
};

/** A log's absolute path and its traces, as `loadLog` read them. */
export type LoadedLog = { logPath: string; traces: Trace[] };

export type QueryDeps = {
  /** The directory `shown` paths are relative to. */
  cwd: string;
  /** The log this `log` option names, read, or why there is none. The CLI
   *  chooses it as the session commands do (`cliLog.ts`); the standard
   *  library reads the one log the caller named and approved. */
  loadLog(log: string | undefined): Promise<LoadedLog | { refused: string }>;
  now(): number;
};

export async function openQueryLog(
  log: string | undefined,
  deps: QueryDeps,
): Promise<OpenedLog | { refused: string }> {
  const loaded = await deps.loadLog(log);
  if ("refused" in loaded) {
    return loaded;
  }
  const { logPath } = loaded;
  const traces = loaded.traces.map((trace): OpenedTrace => {
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
    errorsOutsideTools: summary.errorsOutsideTools,
    toolCalls: summary.toolCalls,
    ...Object.fromEntries(TOOL_TROUBLE.map((trouble) => [trouble.field, summary[trouble.field]])),
    ask: summary.ask ?? null,
  };
}

/** What went wrong in a trace, for the marker column and the summary line:
 *  `error, 2 failed, 1 rejected`. `error` is an error no tool call owns; a
 *  failed tool's own error is in its count. A clean trace gives "". */
export function troubleText(summary: TraceSummary): string {
  return [
    ...(summary.errorsOutsideTools > 0 ? ["error"] : []),
    ...TOOL_TROUBLE.filter((trouble) => summary[trouble.field] > 0).map(
      (trouble) => `${summary[trouble.field]} ${trouble.word}`,
    ),
  ].join(", ");
}
