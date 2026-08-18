// Wire format produced by StatelogClient.post(). Mirrors the envelope
// shape we read from the JSONL file; do NOT depend on the runtime
// SpanContext type here — consumers (logsViewer, eval) must compile
// and run from any JSONL without the runtime loaded.
//
// Lives in `lib/statelog/` rather than `lib/logsViewer/` so the eval
// module (a peer of the viewer, not a dependent) can import these
// types without pulling in viewer internals. The viewer's
// `lib/logsViewer/types.ts` re-exports these.
export type EventEnvelope = {
  format_version: number;
  trace_id: string;
  project_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  data: EventData;
};

export type EventData = {
  type: string;
  timestamp: string;
  // Untyped by design (see above). Notable fields for consumers:
  //   agentStart: `entryNode`, `args`, optional `input` (what the entry node
  //   was given, when the caller named it) and optional `code`
  //   ({ entry, closureHash, closure: [{ file, sha256 }] } — which code ran).
  [key: string]: any;
};
