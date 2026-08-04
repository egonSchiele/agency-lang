// The one owner of the normalized statelog log representation shared by
// `remote logs --json` and the viewer. The viewer parser (lib/statelog/parse.ts)
// requires a truthy `trace_id` and a `data` object with a string `type`, so the
// normalized record carries `trace_id`; JSONL is that same record, one per line.

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

export function traceLogsToJsonl(logs: TraceLog[]): string {
  return normalizeTraceLogs(logs)
    .map((log) => JSON.stringify(log))
    .join("\n");
}
