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
  openQueryLog,
  pickTraces,
  refusal,
  type OpenedLog,
  type QueryDeps,
  type QueryResult,
} from "./shared.js";

/** How many traces `traces` lists when no flag picks them. */
export const DEFAULT_TRACES_SHOWN = 20;
/** Characters of the first user message the table shows. */
export const ASK_COLUMN_CHARS = 60;

export type TracesOptions = TraceSelectionFlags & { log?: string; json: boolean; errors: boolean };

export async function logsTraces(options: TracesOptions, deps: QueryDeps): Promise<QueryResult> {
  const opened = await openQueryLog(options.log, deps);
  if ("refused" in opened) {
    return refusal(opened.refused);
  }
  const log: OpenedLog = options.errors
    ? { ...opened, traces: opened.traces.filter((trace) => trace.summary.hasError) }
    : opened;
  const selection = pickTraces(log, options, DEFAULT_TRACES_SHOWN, deps);
  if (selection.kind === "refused") {
    return refusal(selection.reason);
  }
  const summaries = selection.picked.map((trace) => trace.summary);
  const counted = `${countOf(opened.traces.length, "trace")}${options.errors ? ` · ${countOf(log.traces.length, "with an error", "with errors")}` : ""}`;
  const lines = [logLine(opened, `${counted} · showing ${summaries.length}, newest first`)];
  if (summaries.length > 0) {
    lines.push("", tracesTable(summaries));
  }
  if (selection.older > 0) {
    lines.push(
      "",
      `${countOf(selection.older, "older trace")}. Pass --all to list them, or --since to pick by time.`,
    );
  }
  return {
    text: lines.join("\n"),
    json: {
      log: opened.logPath,
      total: opened.traces.length,
      older: selection.older,
      traces: summaries.map(traceRecord),
    },
    exitCode: 0,
  };
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
