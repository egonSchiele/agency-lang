// Wire types moved to lib/statelog/wireTypes.ts so the eval module
// (a peer of this viewer, not a dependent) can import them without
// pulling in viewer internals. Re-exported here to keep existing
// imports from `logsViewer/types` working.
import type { EventEnvelope, EventData } from "../statelog/wireTypes.js";
export type { EventEnvelope, EventData };

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
  // Earliest event timestamp (ms since epoch) under this node, used
  // by the trace-header summary to show when the run started.
  firstTs?: number;
  // The raw event for leaf nodes. Spans don't carry one (multiple
  // events share a span).
  event?: EventEnvelope;
};
