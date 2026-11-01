// `agency logs traces`: one line per trace, newest first, so an agent can
// tell which run it wants before reading any of it.
import { formatTextTable, oneLine } from "@/cli/runDirectory/table.js";
import { fmtStartedAt, fmtUsd } from "@/logsViewer/format.js";
import { fmtDuration } from "@/logsViewer/spanText.js";
import type { TraceSummary } from "@/logsViewer/traceSummaries.js";
import type { TraceSelectionFlags } from "@/runDirectory/traceSelection.js";

import {
  countOf,
  logLine,
  traceRecord,
  withPickedTraces,
  type OpenedTrace,
  type QueryDeps,
  type QueryResult,
} from "./shared.js";

/** How many traces `traces` lists when no flag picks them. */
export const DEFAULT_TRACES_SHOWN = 20;
/** Characters of the first user message the table shows. */
export const ASK_COLUMN_CHARS = 60;

export type TracesOptions = TraceSelectionFlags & { log?: string; json: boolean; errors: boolean };

export function logsTraces(options: TracesOptions, deps: QueryDeps): Promise<QueryResult> {
  const keep = options.errors ? (trace: OpenedTrace) => trace.summary.hasError : undefined;
  return withPickedTraces(options, { defaultLast: DEFAULT_TRACES_SHOWN, keep }, deps, (found) => {
    const { log, picked, older } = found;
    const summaries = picked.map((trace) => trace.summary);
    const withErrors = log.traces.filter((trace) => trace.summary.hasError).length;
    const counted = [
      countOf(log.traces.length, "trace"),
      ...(options.errors ? [countOf(withErrors, "with an error", "with errors")] : []),
      `showing ${summaries.length}, newest first`,
    ].join(" · ");
    const lines = [logLine(log, counted)];
    if (summaries.length > 0) {
      lines.push("", tracesTable(summaries));
    }
    if (older > 0) {
      lines.push(
        "",
        `${countOf(older, "older trace")}. Pass --all to list them, or --since to pick by time.`,
      );
    }
    return {
      text: lines.join("\n"),
      json: {
        log: log.logPath,
        total: log.traces.length,
        older,
        traces: summaries.map(traceRecord),
      },
      exitCode: 0,
    };
  });
}

function tracesTable(summaries: TraceSummary[]): string {
  return formatTextTable(
    ["trace", "started", "working", "cost", "calls", "agent", "", "first message"],
    summaries.map((summary) => [
      summary.traceId,
      summary.startedAt === undefined ? "—" : fmtStartedAt(summary.startedAt),
      fmtDuration(summary.durationMs, { minutes: true }),
      fmtUsd(summary.costUsd),
      countOf(summary.rounds, "call"),
      summary.agentName ?? "",
      summary.hasError ? "error" : "",
      summary.ask === undefined ? "" : JSON.stringify(oneLine(summary.ask, ASK_COLUMN_CHARS)),
    ]),
    (header) => header,
  );
}
