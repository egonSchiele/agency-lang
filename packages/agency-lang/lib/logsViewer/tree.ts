import { EventEnvelope, TreeNode } from "./types.js";
import { summarize, summarizeSpan, summarizeTrace } from "./summary.js";

// Event types the viewer skips entirely. `graph` is a one-shot
// schema dump (nodes + edges + start node) emitted at the top of
// each agent run; useful in the JSONL for tooling but not in the
// interactive tree.
const HIDDEN_EVENT_TYPES = new Set<string>(["graph"]);

export function buildForest(events: EventEnvelope[]): TreeNode[] {
  // traceId → trace root
  const traces: Record<string, TreeNode> = {};
  // span_id → span node (lookup across all traces; span_ids are globally unique per nanoid)
  const spans: Record<string, TreeNode> = {};
  // span_id → its desired parent_span_id (as observed on first sight).
  // Tracked separately so pass 1b can re-resolve parents once every
  // span exists, without polluting the public TreeNode shape.
  const desiredParent: Record<string, string | null> = {};

  // Pass 1a: create traces and spans, linking each span to its parent
  // (or trace root) in arrival order. This puts child spans into their
  // parent's `children` array BEFORE any leaf events get appended in
  // pass 2, so a span's child spans are always listed before its leaves.
  for (const evt of events) {
    ensureTrace(traces, evt.trace_id);
    if (evt.span_id) {
      ensureSpan(spans, traces, evt);
      if (!(evt.span_id in desiredParent)) {
        desiredParent[evt.span_id] = evt.parent_span_id ?? null;
      }
    }
  }

  // Pass 1b: re-resolve any span that was attached to the trace root
  // because its parent_span_id had not been seen yet. After pass 1a
  // every span that will ever exist does exist, so we can move the
  // child under its true parent if it shows up now. This makes the
  // tree shape order-independent.
  for (const span of Object.values(spans)) {
    const desiredParentId = desiredParent[span.id];
    if (!desiredParentId) continue;
    const trueParent = spans[desiredParentId];
    if (!trueParent || span.parentId === trueParent.id) continue;
    // Detach from current parent and re-attach to the true parent.
    const traceRoot = traces[span.traceId];
    traceRoot.children = traceRoot.children.filter((c) => c.id !== span.id);
    span.parentId = trueParent.id;
    trueParent.children.push(span);
  }

  // Pass 2: attach each event as a leaf under its span (or under the
  // trace root if it has no span_id), preserving arrival order. Some
  // event types are noise (e.g. the `graph` schema dump) and are
  // hidden from the viewer entirely.
  let leafCounter = 0;
  for (const evt of events) {
    if (HIDDEN_EVENT_TYPES.has(evt.data.type)) continue;
    const traceRoot = traces[evt.trace_id];
    const parent = evt.span_id ? spans[evt.span_id] : traceRoot;
    const leaf: TreeNode = {
      id: `evt-${leafCounter++}`,
      traceId: evt.trace_id,
      parentId: parent.id,
      children: [],
      nodeKind: "event",
      label: evt.data.type,
      summary: summarize(evt),
      event: evt,
    };
    parent.children.push(leaf);
  }

  // Pass 3: aggregate metrics on each span.
  for (const span of Object.values(spans)) {
    aggregateMetrics(span);
  }
  // Aggregate trace-level metrics from immediate span children too.
  for (const trace of Object.values(traces)) {
    aggregateMetrics(trace);
    trace.summary = summarizeTrace(trace);
  }

  // Pass 4: sort each node's children in chronological order. Spans
  // sort by their aggregated firstTs (computed in pass 3); leaves by
  // their own timestamp. Children with missing/invalid timestamps
  // keep their original arrival position via a stable sort.
  for (const trace of Object.values(traces)) {
    sortChildrenByTime(trace);
  }

  return Object.values(traces);
}

function sortChildrenByTime(node: TreeNode): void {
  // Decorate with the original index so we can fall back to arrival
  // order whenever timestamps tie or are missing (stable sort).
  const decorated = node.children.map((child, idx) => ({
    child,
    ts: nodeSortTs(child),
    idx,
  }));
  decorated.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.idx - b.idx;
  });
  node.children = decorated.map((d) => d.child);
  for (const child of node.children) sortChildrenByTime(child);
}

function nodeSortTs(node: TreeNode): number {
  if (node.event) {
    const t = Date.parse(node.event.data.timestamp);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  }
  return node.firstTs ?? Number.POSITIVE_INFINITY;
}

function ensureTrace(
  traces: Record<string, TreeNode>,
  traceId: string,
): TreeNode {
  const existing = traces[traceId];
  if (existing) return existing;
  const root: TreeNode = {
    id: `trace-${traceId}`,
    traceId,
    parentId: null,
    children: [],
    nodeKind: "trace",
    label: traceId,
    summary: "",
  };
  traces[traceId] = root;
  return root;
}

function ensureSpan(
  spans: Record<string, TreeNode>,
  traces: Record<string, TreeNode>,
  evt: EventEnvelope,
): TreeNode {
  const existing = spans[evt.span_id!];
  if (existing) return existing;
  const node: TreeNode = {
    id: evt.span_id!,
    traceId: evt.trace_id,
    parentId: evt.parent_span_id ?? null,
    children: [],
    nodeKind: "span",
    // Use the introducing event's type as a hint for the span type;
    // refined when we know more (e.g. agentStart → agentRun).
    label: inferSpanLabel(evt),
    summary: "",
  };
  spans[evt.span_id!] = node;

  // Attach to parent span (if known) or to the trace root.
  const parent = evt.parent_span_id
    ? (spans[evt.parent_span_id] ?? ensureTrace(traces, evt.trace_id))
    : ensureTrace(traces, evt.trace_id);
  node.parentId = parent.id;
  parent.children.push(node);
  return node;
}

function inferSpanLabel(evt: EventEnvelope): string {
  switch (evt.data.type) {
    case "agentStart":
    case "agentEnd":
      return "agentRun";
    case "enterNode":
      return "nodeExecution";
    case "promptCompletion":
      return "llmCall";
    case "embedCompletion":
      // Embedding spans share the chat-completion shape but get their
      // own label so the viewer can color/filter them separately and
      // cost roll-ups don't conflate the two.
      return "embedding";
    case "toolCallStart":
    case "toolCall":
      // A tool execution emits `toolCallStart` first, so the span is
      // usually introduced by it — label both as `toolExecution` so the
      // span reads consistently regardless of which event created it.
      return "toolExecution";
    case "forkStart":
    case "forkEnd":
      return evt.data.mode === "race" ? "race" : "forkAll";
    case "handlerDecision":
      return "handlerChain";
    default:
      // The memory umbrella events (`memoryRemember`, `memoryRecall`,
      // `memoryForget`, `memoryCompaction`) intentionally hit this
      // branch — their event type already matches the SpanType, so the
      // default returns the right label without a per-case mapping.
      return evt.data.type;
  }
}

function aggregateMetrics(node: TreeNode): void {
  const leaves: TreeNode[] = [];
  walk(node, (n) => {
    if (n.event) leaves.push(n);
  });

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const tokens = sum(
    leaves
      .filter((l) => l.event!.data.type === "promptCompletion")
      .map((l) => {
        const u = l.event!.data.usage ?? {};
        return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      }),
  );

  const cost = sum(
    leaves
      .filter((l) => l.event!.data.type === "promptCompletion")
      .map((l) => l.event!.data.cost?.totalCost ?? 0),
  );

  const timestamps = leaves
    .map((l) => Date.parse(l.event!.data.timestamp))
    .filter(Number.isFinite);

  if (tokens > 0) node.tokens = tokens;
  if (cost > 0) node.cost = cost;
  if (timestamps.length >= 1) {
    node.firstTs = Math.min(...timestamps);
  }

  // Duration is the span's wall-clock ENVELOPE: earliest start to latest
  // end across all of its events. Events record their *emission* time
  // (`timestamp`) and, where known, their own length (`timeTaken`), so an
  // event's start is `timestamp - timeTaken`. Taking max(end) - min(start):
  //  - a single completion event (e.g. a one-round llmCall) yields its
  //    real latency via timeTaken — emission timestamps alone would give
  //    ~0ms since they cluster at the end;
  //  - a multi-event span yields its true wall-clock;
  //  - parallel/nested work is never SUMMED (it's an envelope, not a
  //    sum) — previously an llmCall's duration summed every nested
  //    promptCompletion, so a tool that forked N parallel LLM calls made
  //    the parent look N× longer than it ran;
  //  - parent ⊇ child holds, because a parent's leaves are a superset of
  //    each child's.
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const l of leaves) {
    const ts = Date.parse(l.event!.data.timestamp);
    if (!Number.isFinite(ts)) continue;
    const tt =
      typeof l.event!.data.timeTaken === "number" ? l.event!.data.timeTaken : 0;
    if (ts - tt < minStart) minStart = ts - tt;
    if (ts > maxEnd) maxEnd = ts;
  }
  if (Number.isFinite(minStart) && maxEnd > minStart) {
    node.duration = maxEnd - minStart;
  }

  if (node.nodeKind === "span") {
    node.summary = summarizeSpan(node);
  }
}

function walk(node: TreeNode, visit: (n: TreeNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}
