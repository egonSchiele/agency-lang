// Wire format produced by StatelogClient.post(). Mirrors the envelope
// shape we read from the JSONL file; do NOT depend on the runtime
// SpanContext type here — the viewer must compile and run from any
// JSONL without the runtime loaded.
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
  [key: string]: any;
};

// One node in the visible tree. Spans (have children) and leaf events
// (no children) share this shape — `nodeKind` discriminates.
export type TreeNode = {
  id: string; // span_id for spans; "evt-<index>" for leaves
  traceId: string;
  parentId: string | null;
  children: TreeNode[];
  nodeKind: "trace" | "span" | "event";
  // For "trace": the trace_id; for "span": the span type (agentRun,
  // llmCall, ...); for "event": the data.type.
  label: string;
  // Pre-computed display summary, e.g. `llmCall (1.2s, 1500 tok, $0.007)`.
  summary: string;
  // For spans, aggregated from descendants; for events, drawn from
  // the event payload.
  duration?: number;
  tokens?: number;
  cost?: number;
  // The raw event for leaf nodes. Spans don't carry one (multiple
  // events share a span).
  event?: EventEnvelope;
};

export type ViewerState = {
  // The full forest (one root per trace_id).
  roots: TreeNode[];
  // ids of every node currently expanded.
  expanded: Set<string>;
  // Currently-focused node id (cursor position).
  cursorId: string;
  // Vertical scroll offset (line of the first visible row).
  scrollTop: number;
  // Set by the input layer; consumed by the run loop.
  quit: boolean;
};
