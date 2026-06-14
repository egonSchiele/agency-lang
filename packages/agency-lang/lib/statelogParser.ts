import * as fs from "fs";
import type { EventEnvelope } from "./statelog/wireTypes.js";
import {
  spanLabelOf,
  summarizeEvent,
  summarizeSpanText,
  summarizeTraceText,
} from "./statelog/summarize.js";
import {
  byType,
  cost,
  modelOf,
  timestampMs,
  tokensIn,
  tokensOut,
  toolNameOf,
} from "./statelog/wireAccessors.js";
import { extractEvalRecord, type ExtractOptions } from "./eval/extract.js";
import { normalize, type Normalized } from "./eval/normalize.js";
import type {
  ErrorEntry,
  EvalRecord,
  EvalValue,
  IncompleteInvocation,
  InterruptEntry,
  Metrics,
  NormalizedEvent,
  ThreadEntry,
} from "./eval/types.js";

export type StatelogParserOptions = ExtractOptions;

const SUPPORTED_VERSION = 1;

export type ParseError = {
  line: number;
  kind: "invalid_json" | "missing_fields" | "unsupported_version";
  detail: string;
};

// One kept event plus its 1-based source line. The line number is the stable
// identity for event nodes (`evt-<lineNo>`) and is what `lines()` yields.
type ParsedEvent = { event: EventEnvelope; lineNo: number };
type ParseResult = { events: ParsedEvent[]; errors: ParseError[] };

export type NodeKind = "trace" | "span" | "event";

export type NodeMetrics = {
  tokens?: number;
  cost?: number;
  durationMs?: number;
  firstTs?: number;
};

// One node in the logical trace→span→event hierarchy. Spans (have children)
// and leaf events (no children) share this shape — `kind` discriminates. No
// full payload is held: leaves carry `lineNo`, and the payload is fetched
// lazily via `eventOf(id)` (Tier-2). The plain-text `summary` is computed at
// build time so consumers can render/grep a one-liner without the payload.
export type StatelogNode = {
  id: string; // trace-<traceId> | <span_id> | evt-<lineNo>
  kind: NodeKind;
  traceId: string;
  parentId: string | null;
  children: StatelogNode[];
  label: string; // span type / event type / trace id
  summary: string; // plain-text one-liner (grep-able)
  metrics?: NodeMetrics; // rolled up for spans/traces; from the event for leaves
  lineNo?: number; // events only — used by eventOf()
};

type BuiltNodes = {
  roots: StatelogNode[];
  byId: Record<string, StatelogNode>;
  eventByLine: Record<number, EventEnvelope>;
};

export type LlmCall = {
  traceId: string;
  spanId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  tMs: number;
};

export type ToolCall = {
  traceId: string;
  spanId: string | null;
  toolName: string;
  tMs: number;
};

// Tolerant line-by-line JSONL parse. Malformed lines, unsupported
// `format_version`, and rows missing `trace_id`/`data.type` are collected as
// `ParseError`s rather than thrown, so the logs viewer can render a partial
// tree plus an error count. The eval path re-imposes strictness (see
// `evalRecord`). Folds in the validation that used to live in
// `lib/logsViewer/parse.ts`.
function parseStatelogText(text: string): ParseResult {
  const events: ParsedEvent[] = [];
  const errors: ParseError[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (raw.trim() === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      errors.push({ line: i + 1, kind: "invalid_json", detail: (e as Error).message });
      continue;
    }
    const rawVersion = obj.format_version;
    // Missing format_version is treated as a legacy v1 file. Present-but-non-
    // numeric is rejected so the EventEnvelope.format_version invariant holds.
    if (rawVersion !== undefined && typeof rawVersion !== "number") {
      errors.push({
        line: i + 1,
        kind: "unsupported_version",
        detail: `format_version must be a number, got ${typeof rawVersion}`,
      });
      continue;
    }
    const version: number = rawVersion ?? 1;
    if (version > SUPPORTED_VERSION) {
      errors.push({
        line: i + 1,
        kind: "unsupported_version",
        detail: `format_version ${version} > ${SUPPORTED_VERSION}`,
      });
      continue;
    }
    if (!obj.trace_id || !obj.data || typeof obj.data.type !== "string") {
      errors.push({ line: i + 1, kind: "missing_fields", detail: "missing trace_id or data.type" });
      continue;
    }
    events.push({
      event: {
        format_version: version,
        trace_id: obj.trace_id,
        project_id: obj.project_id ?? "",
        span_id: obj.span_id ?? null,
        parent_span_id: obj.parent_span_id ?? null,
        data: obj.data,
      },
      lineNo: i + 1,
    });
  }
  return { events, errors };
}

export class StatelogParser {
  private readonly parsed: ParseResult;
  private normalizedCache?: Normalized;
  private evalRecordCache?: EvalRecord;
  private nodesCache?: BuiltNodes;

  // The ONLY constructor. Both factories funnel through it, so there is a
  // single place where text / filePath / parsed are established together.
  private constructor(
    text: string,
    private readonly filePath: string | null,
    private readonly options: StatelogParserOptions = {},
  ) {
    this.parsed = parseStatelogText(text);
  }

  static fromFile(filePath: string, options: StatelogParserOptions = {}): StatelogParser {
    return new StatelogParser(fs.readFileSync(filePath, "utf-8"), filePath, options);
  }

  static fromString(jsonl: string, options: StatelogParserOptions = {}): StatelogParser {
    return new StatelogParser(jsonl, null, options);
  }

  // Iterable (not Array) to honor the streaming-ready contract — a future
  // indexed backend can yield without materializing the whole file.
  *events(): Iterable<EventEnvelope> {
    for (const p of this.parsed.events) yield p.event;
  }

  parseErrors(): ParseError[] {
    return this.parsed.errors;
  }

  private nodes(): BuiltNodes {
    if (!this.nodesCache) this.nodesCache = buildNodes(this.parsed.events);
    return this.nodesCache;
  }

  getNodeById(id: string): StatelogNode | undefined {
    return this.nodes().byId[id];
  }

  // Tier-2 payload fetch: returns the full EventEnvelope behind an event node.
  eventOf(id: string): EventEnvelope | undefined {
    const node = this.getNodeById(id);
    if (!node || node.lineNo === undefined) return undefined;
    return this.nodes().eventByLine[node.lineNo];
  }

  traces(): TraceView[] {
    return this.nodes().roots.map((r) => new TraceView(this, r));
  }

  trace(traceId: string): TraceView {
    const root = this.nodes().roots.find((r) => r.traceId === traceId);
    if (!root) throw new Error(`No trace with id ${traceId}`);
    return new TraceView(this, root);
  }

  onlyTrace(): TraceView {
    const roots = this.nodes().roots;
    if (roots.length > 1) {
      throw new Error(
        `multiple traces in input (${roots.map((r) => r.traceId).join(", ")}). Exactly one supported.`,
      );
    }
    if (roots.length === 0) throw new Error("no traces in input");
    return new TraceView(this, roots[0]);
  }

  // Typed queries (span every trace; TraceView exposes scoped variants). Read
  // through wireAccessors so wire-format knowledge stays in one place.
  llmCalls(): LlmCall[] {
    return byType(this.parsed.events.map((p) => p.event), "promptCompletion").map((e) => ({
      traceId: e.trace_id,
      spanId: e.span_id,
      model: modelOf(e),
      tokensIn: tokensIn(e),
      tokensOut: tokensOut(e),
      cost: cost(e),
      tMs: timestampMs(e),
    }));
  }

  toolCalls(): ToolCall[] {
    return byType(this.parsed.events.map((p) => p.event), "toolCall").map((e) => ({
      traceId: e.trace_id,
      spanId: e.span_id,
      toolName: toolNameOf(e),
      tMs: timestampMs(e),
    }));
  }

  // Yield each parsed event with its 1-based source line — the "yield each line
  // of the log" accessor.
  *lines(): Iterable<{ lineNo: number; event: EventEnvelope }> {
    for (const p of this.parsed.events) yield { lineNo: p.lineNo, event: p.event };
  }

  // The pre-refactor sync parser threw on the first malformed line, so the
  // eval-facing methods (normalized/evalRecord and everything derived from
  // them) refuse to operate on a partially-parsed file. Tolerant consumers
  // (the viewer) use parseErrors() + the hierarchy/query APIs instead.
  private assertNoParseErrors(): void {
    const errors = this.parseErrors();
    if (errors.length > 0) {
      throw new Error(`Malformed statelog on line ${errors[0].line}: ${errors[0].detail}`);
    }
  }

  normalized(): Normalized {
    if (!this.normalizedCache) {
      this.assertNoParseErrors();
      const events = this.parsed.events.map((p) => p.event);
      assertSingleTrace(events);
      this.normalizedCache = normalize(events);
    }
    return this.normalizedCache;
  }

  evalRecord(): EvalRecord {
    if (!this.evalRecordCache) {
      this.assertNoParseErrors();
      const events = this.parsed.events.map((p) => p.event);
      assertSingleTrace(events);
      this.evalRecordCache = extractEvalRecord(events, this.filePath ?? "<string>", this.options);
    }
    return this.evalRecordCache;
  }

  evalInputs(): EvalValue[] {
    return this.evalRecord().evalInputs;
  }

  evalOutputs(): EvalValue[] {
    return this.evalRecord().evalOutputs;
  }

  finalEvalOutput(): EvalValue | null {
    return this.evalOutputs().at(-1) ?? null;
  }

  threads(): ThreadEntry[] {
    return this.evalRecord().threads;
  }

  normalizedEvents(): NormalizedEvent[] {
    return this.evalRecord().events;
  }

  interrupts(): InterruptEntry[] {
    return this.evalRecord().interrupts;
  }

  errors(): ErrorEntry[] {
    return this.evalRecord().errors;
  }

  incompleteInvocations(): IncompleteInvocation[] {
    return this.evalRecord().incomplete;
  }

  metrics(): Metrics {
    return this.evalRecord().metrics;
  }

  warnings(): string[] {
    return this.evalRecord().warnings;
  }
}

// A query scoped to one trace. A class (not a factory-returned object) so the
// fluent surface — parser.trace(id).llmCalls(), parser.onlyTrace().root(),
// parser.traces()[i].getNodeById(…) — is one well-defined type. Its query
// methods mirror the parser's so a scoped call reads the same as the global.
export class TraceView {
  constructor(
    private readonly parser: StatelogParser,
    private readonly rootNode: StatelogNode,
  ) {}

  get traceId(): string {
    return this.rootNode.traceId;
  }

  root(): StatelogNode {
    return this.rootNode;
  }

  getNodeById(id: string): StatelogNode | undefined {
    const n = this.parser.getNodeById(id);
    return n && n.traceId === this.rootNode.traceId ? n : undefined;
  }

  llmCalls(): LlmCall[] {
    return this.parser.llmCalls().filter((c) => c.traceId === this.rootNode.traceId);
  }

  toolCalls(): ToolCall[] {
    return this.parser.toolCalls().filter((c) => c.traceId === this.rootNode.traceId);
  }
}

// Build the trace→span→event hierarchy from the parsed events. Ported from the
// viewer's buildForest, producing StatelogNode (no view fields) and keeping ALL
// event types (hiding `graph` is a view concern). Four passes: create
// traces/spans, re-resolve parents (order-independent), attach leaf events,
// roll up metrics, then sort children chronologically.
function buildNodes(parsed: ParsedEvent[]): BuiltNodes {
  const traces: Record<string, StatelogNode> = {};
  const spans: Record<string, StatelogNode> = {};
  const desiredParent: Record<string, string | null> = {};
  const eventByLine: Record<number, EventEnvelope> = {};

  // Pass 1a: create traces and spans in arrival order.
  for (const { event: evt } of parsed) {
    ensureTrace(traces, evt.trace_id);
    if (evt.span_id) {
      ensureSpan(spans, traces, evt);
      if (!(evt.span_id in desiredParent)) {
        desiredParent[evt.span_id] = evt.parent_span_id ?? null;
      }
    }
  }

  // Pass 1b: re-resolve any span attached to the trace root because its parent
  // had not been seen yet. Makes the tree shape order-independent.
  for (const span of Object.values(spans)) {
    const desiredParentId = desiredParent[span.id];
    if (!desiredParentId) continue;
    const trueParent = spans[desiredParentId];
    if (!trueParent || span.parentId === trueParent.id) continue;
    const traceRoot = traces[span.traceId];
    traceRoot.children = traceRoot.children.filter((c) => c.id !== span.id);
    span.parentId = trueParent.id;
    trueParent.children.push(span);
  }

  // Pass 2: attach each event as a leaf under its span (or the trace root).
  for (const { event: evt, lineNo } of parsed) {
    eventByLine[lineNo] = evt;
    const traceRoot = traces[evt.trace_id];
    const parent = evt.span_id ? spans[evt.span_id] : traceRoot;
    const leaf: StatelogNode = {
      // Hyphen (not colon) so the viewer's synthetic-row ids
      // (`<leafId>:convo:…`, `<leafId>:raw`) stay parseable by splitting on the
      // first colon. Still line-derived → stable + offset-friendly.
      id: `evt-${lineNo}`,
      traceId: evt.trace_id,
      parentId: parent.id,
      children: [],
      kind: "event",
      label: evt.data.type,
      summary: summarizeEvent(evt),
      lineNo,
    };
    parent.children.push(leaf);
  }

  // Pass 3: aggregate metrics on spans, then traces.
  for (const span of Object.values(spans)) {
    aggregateMetrics(span, eventByLine);
  }
  for (const trace of Object.values(traces)) {
    aggregateMetrics(trace, eventByLine);
    trace.summary = summarizeTraceText(trace.traceId, trace.metrics?.firstTs, trace.metrics ?? {});
  }

  // Pass 4: sort children chronologically (stable on ties / missing times).
  for (const trace of Object.values(traces)) {
    sortChildrenByTime(trace, eventByLine);
  }

  const byId: Record<string, StatelogNode> = {};
  for (const trace of Object.values(traces)) indexNode(trace, byId);

  return { roots: Object.values(traces), byId, eventByLine };
}

function ensureTrace(traces: Record<string, StatelogNode>, traceId: string): StatelogNode {
  const existing = traces[traceId];
  if (existing) return existing;
  const root: StatelogNode = {
    id: `trace-${traceId}`,
    traceId,
    parentId: null,
    children: [],
    kind: "trace",
    label: traceId,
    summary: "",
  };
  traces[traceId] = root;
  return root;
}

function ensureSpan(
  spans: Record<string, StatelogNode>,
  traces: Record<string, StatelogNode>,
  evt: EventEnvelope,
): StatelogNode {
  const existing = spans[evt.span_id!];
  if (existing) return existing;
  const node: StatelogNode = {
    id: evt.span_id!,
    traceId: evt.trace_id,
    parentId: evt.parent_span_id ?? null,
    children: [],
    kind: "span",
    label: spanLabelOf(evt),
    summary: "",
  };
  spans[evt.span_id!] = node;
  const parent = evt.parent_span_id
    ? (spans[evt.parent_span_id] ?? ensureTrace(traces, evt.trace_id))
    : ensureTrace(traces, evt.trace_id);
  node.parentId = parent.id;
  parent.children.push(node);
  return node;
}

function aggregateMetrics(
  node: StatelogNode,
  eventByLine: Record<number, EventEnvelope>,
): void {
  const leaves: StatelogNode[] = [];
  walkNode(node, (n) => {
    if (n.kind === "event") leaves.push(n);
  });
  const eventOf = (l: StatelogNode): EventEnvelope => eventByLine[l.lineNo!];
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const metrics: NodeMetrics = {};

  const tokens = sum(
    leaves
      .filter((l) => eventOf(l).data.type === "promptCompletion")
      .map((l) => {
        const u = eventOf(l).data.usage ?? {};
        return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      }),
  );
  const cost = sum(
    leaves
      .filter((l) => eventOf(l).data.type === "promptCompletion")
      .map((l) => eventOf(l).data.cost?.totalCost ?? 0),
  );
  const timestamps = leaves
    .map((l) => Date.parse(eventOf(l).data.timestamp))
    .filter(Number.isFinite);

  if (tokens > 0) metrics.tokens = tokens;
  if (cost > 0) metrics.cost = cost;
  if (timestamps.length >= 1) metrics.firstTs = Math.min(...timestamps);

  // Prefer the authoritative `timeTaken` field on the span's characteristic
  // leaf events; fall back to the timestamp span.
  const measured = measuredDuration(node, leaves, eventByLine);
  if (measured !== undefined) metrics.durationMs = measured;
  else if (timestamps.length >= 2) {
    metrics.durationMs = Math.max(...timestamps) - Math.min(...timestamps);
  }

  if (Object.keys(metrics).length > 0) node.metrics = metrics;

  if (node.kind === "span") {
    node.summary = summarizeSpanText(node.label, node.metrics ?? {});
  }
}

function measuredDuration(
  node: StatelogNode,
  leaves: StatelogNode[],
  eventByLine: Record<number, EventEnvelope>,
): number | undefined {
  if (node.kind !== "span") return undefined;
  const target = durationEventType(node.label);
  const times = leaves
    .filter((l) => eventByLine[l.lineNo!].data.type === target)
    .map((l) => eventByLine[l.lineNo!].data.timeTaken)
    .filter((t): t is number => typeof t === "number");
  if (times.length === 0) return undefined;
  return times.reduce((a, b) => a + b, 0);
}

function durationEventType(spanLabel: string): string | undefined {
  switch (spanLabel) {
    case "llmCall": return "promptCompletion";
    case "toolExecution": return "toolCall";
    case "agentRun": return "agentEnd";
    case "forkAll":
    case "race": return "forkEnd";
    default: return undefined;
  }
}

function sortChildrenByTime(
  node: StatelogNode,
  eventByLine: Record<number, EventEnvelope>,
): void {
  const decorated = node.children.map((child, idx) => ({
    child,
    ts: nodeSortTs(child, eventByLine),
    idx,
  }));
  decorated.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.idx - b.idx));
  node.children = decorated.map((d) => d.child);
  for (const child of node.children) sortChildrenByTime(child, eventByLine);
}

function nodeSortTs(
  node: StatelogNode,
  eventByLine: Record<number, EventEnvelope>,
): number {
  if (node.kind === "event") {
    const t = Date.parse(eventByLine[node.lineNo!].data.timestamp);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  }
  return node.metrics?.firstTs ?? Number.POSITIVE_INFINITY;
}

function walkNode(node: StatelogNode, visit: (n: StatelogNode) => void): void {
  visit(node);
  for (const c of node.children) walkNode(c, visit);
}

function indexNode(node: StatelogNode, byId: Record<string, StatelogNode>): void {
  byId[node.id] = node;
  for (const c of node.children) indexNode(c, byId);
}

function assertSingleTrace(events: EventEnvelope[]): void {
  const traceIds: Record<string, true> = {};
  for (const event of events) {
    traceIds[event.trace_id] = true;
  }
  const ids = Object.keys(traceIds);
  if (ids.length > 1) {
    throw new Error(
      `extract: multiple trace_ids in input (${ids.join(", ")}). Exactly one trace per file is supported.`,
    );
  }
}
