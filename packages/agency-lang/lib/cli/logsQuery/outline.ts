// `agency logs outline`: every row of a trace with its address, so an agent
// can read what happened in a run and pick the rows to open with
// `agency logs session show`.
import { oneLine } from "@/cli/runDirectory/table.js";
import { fmtStartedAt, fmtUsd } from "@/logsViewer/format.js";
import { outlineLines, type OutlineFlags, type OutlineLine } from "@/logsViewer/outlineText.js";
import { fmtDuration } from "@/logsViewer/spanText.js";
import type { TraceSummary } from "@/logsViewer/traceSummaries.js";
import type { TraceSelectionFlags } from "@/runDirectory/traceSelection.js";

import {
  countOf,
  logLine,
  MOST_RECENT_ONLY,
  traceRecord,
  withPickedTraces,
  type QueryDeps,
  type QueryResult,
} from "./shared.js";

/** The widest a row's header prints. A user turn's header is the first
 *  line of its message, which can be a whole paragraph. */
export const HEADER_CHARS = 120;

export type OutlineOptions = TraceSelectionFlags & OutlineFlags & { log?: string; json: boolean };

export function logsOutline(options: OutlineOptions, deps: QueryDeps): Promise<QueryResult> {
  return withPickedTraces(options, { defaultLast: MOST_RECENT_ONLY }, deps, ({ log, picked }) => {
    const traces = picked.map((trace) => ({
      summary: trace.summary,
      lines: outlineLines(trace.root, options).map((line) => ({
        ...line,
        header: oneLine(line.header, HEADER_CHARS),
      })),
    }));
    const shown = `outline of ${countOf(traces.length, "trace")} · ${countOf(log.traces.length, "trace")} in the log`;
    const text = [
      logLine(log, shown),
      ...traces.flatMap((trace) => ["", summaryLine(trace.summary), "", ...rowLines(trace.lines)]),
    ].join("\n");
    return {
      text,
      json: {
        log: log.logPath,
        traces: traces.map((trace) => ({ ...traceRecord(trace.summary), rows: trace.lines })),
      },
      exitCode: 0,
    };
  });
}

/** `<trace id> · <started> · N LLM calls · <working time> · <cost> · error` */
export function summaryLine(summary: TraceSummary): string {
  return [
    summary.traceId,
    summary.startedAt === undefined ? undefined : fmtStartedAt(summary.startedAt).trim(),
    countOf(summary.rounds, "LLM call"),
    fmtDuration(summary.durationMs, { minutes: true }),
    fmtUsd(summary.costUsd),
    summary.hasError ? "error" : undefined,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

/** The address padded to one width, then the header indented by depth. */
function rowLines(lines: OutlineLine[]): string[] {
  const width = Math.max(0, ...lines.map((line) => line.address.length));
  return lines.map(
    (line) => `${line.address.padEnd(width)}  ${"  ".repeat(line.depth)}${line.header}`,
  );
}
