import type { DecisionAnswer, DecisionQuestion, DecisionState } from "smoltalk";

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

/** On a `promptCompletion` from a decision model: what the model was sent
 *  and what it answered. The state is the thread as the model read it
 *  (role and text only), the questions are what the response type became,
 *  and the answers are the model's reply before it was turned back into a
 *  value. Absent on a text call. The three parts reuse smoltalk's decision
 *  types so the log and the wire protocol cannot drift apart. */
export type DecisionLog = {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  answers: Record<string, DecisionAnswer>;
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
