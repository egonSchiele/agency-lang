// The one owner of the normalized statelog log representation shared by
// `remote logs --json` and the viewer. The viewer's checks
// (lib/statelog/parse.ts) require a truthy `trace_id` and a `data` object with
// a string `type`, so the normalized record carries `trace_id`. The viewer gets
// those same records, checked the way a line from a file is.

import { parseStatelogRecords, type ParseResult } from "@/statelog/parse.js";
import type { TraceLog } from "../statelog/projectClient.js";

export type ViewerTraceLog = {
  trace_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  data: { type: string } & Record<string, unknown>;
};

export function normalizeTraceLogs(logs: TraceLog[]): ViewerTraceLog[] {
  return logs.map((log) => ({
    trace_id: log.traceId,
    span_id: log.spanId,
    parent_span_id: log.parentSpanId,
    data: log.data,
  }));
}

/** The fetched logs as the viewer's parsed log. */
export function traceLogsToEvents(logs: TraceLog[]): ParseResult {
  return parseStatelogRecords(normalizeTraceLogs(logs));
}
