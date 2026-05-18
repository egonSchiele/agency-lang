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
  // Synthetic, on-the-fly rows generated when a leaf event is
  // expanded — none are part of the persistent forest:
  //   - "jsonLine"      : one rendered line of the leaf's JSON payload
  //   - "convoLine"     : one rendered conversation message (promptCompletion only)
  //   - "rawDataToggle" : expandable "raw data" header that, when opened,
  //                       reveals the underlying JSON payload as jsonLine rows
  nodeKind: "trace" | "span" | "event" | "jsonLine" | "convoLine" | "rawDataToggle";
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
  // Earliest event timestamp (ms since epoch) under this node, used
  // by the trace-header summary to show when the run started.
  firstTs?: number;
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
  // ---- v2 additions ----
  // Active substring query for `/`, `n`, `N`. Empty when search is off.
  query?: string;
  // Node ids that currently match `query`, in flatten order.
  matches?: string[];
  // Index into `matches` for the current "n/N" position.
  matchIdx?: number;
  // Help-screen overlay shown?
  helpOpen?: boolean;
  // Follow mode (`--follow` / `f`) — viewer re-reads the file when it grows.
  followOn?: boolean;
  // One-line status message (`copied 312 bytes`, etc.); auto-clears
  // on the next keystroke. Owned by the input layer.
  messageBar?: string;
  // Width (in terminal columns) available to the viewer. Used to
  // wrap long convoLine summaries onto multiple visible rows so
  // promptCompletion messages aren't truncated with `…`. Kept on
  // state so the renderer, input layer, and search all agree on
  // the same row set.
  viewportCols?: number;
};
