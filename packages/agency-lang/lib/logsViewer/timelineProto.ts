// ═══════════════════════════════════════════════════════════════════════
// PROTOTYPE — THROWAWAY CODE. Do not ship, do not test, do not polish.
//
// Question this answers: what should the timeline views of a single run
// look like in the terminal, and how should drill-down / labels / detail
// behave? Views, cycled with `t` from the normal tree view:
//   flame       row per call, indented; Enter/→ drills in, ← climbs out
//   byName      row per function; Enter opens that name's occurrences
//   occurrences every call of one name, with where-it-came-from context
//   detail      full info for one call (prompt transcript, args, cost)
// Everything lives in this one file; run.ts has a small marked hook.
// The real implementation will be rebuilt properly from what we learn.
// ═══════════════════════════════════════════════════════════════════════
import { column, line } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import { scrollList } from "../tui/scrollList.js";
import type { KeyEvent } from "../tui/input/types.js";
import { formatConversation } from "./conversation.js";
import { expandAncestorsOf } from "./search.js";
import type { TreeNode, ViewerState } from "./types.js";

type ProtoSpan = {
  node: TreeNode;
  name: string;       // grouping key + color key, e.g. `llm(claude-sonnet-5)`, `bash`
  label: string;      // flame row text, e.g. `llm · "Analyze the gcode…"`
  detail: string;     // per-call extra: tokens+cost, or the bash command
  kind: string;
  depth: number;
  start: number;
  end: number;
  // Envelope minus the direct child spans: time spent in this span itself,
  // not waiting on nested work. Without this the top-level llmCall span
  // (which envelopes the whole tool loop) was credited 193% of a run.
  selfIntervals: [number, number][];
  selfMs: number;
};

type NameRow = {
  name: string;
  kind: string;
  count: number;
  totalMs: number;
  share: number;
  spans: ProtoSpan[];
};

// Spans hidden by default: per-interrupt handler bookkeeping appears under
// every single tool call (90× in one run) and buries the signal. `h` shows.
const ADMIN_KINDS = ["handlerChain", "threadEndHooks"];

type ProtoView = "flame" | "byName" | "occ" | "detail";

export type ProtoState = {
  view: ProtoView;
  traceLabel: string;
  path: TreeNode[];         // drill stack; last entry is the current root
  hideAdmin: boolean;
  // derived from the current root (deriveView)
  spans: ProtoSpan[];
  byName: NameRow[];
  colors: Record<string, string>;
  rootStart: number;
  rootEnd: number;
  t0: number;
  t1: number;
  cursor: number;
  scrollTop: number;
  // occurrences view
  occName?: string;
  occSpans?: ProtoSpan[];
  // detail view
  detailTitle?: string;
  detailLines?: string[];
  detailScroll: number;
  detailReturn?: ProtoView;
  // set by `o`: leave the prototype and focus this span in the tree
  jumpToSpanId?: string;
  exit?: boolean;
};

const PALETTE = [
  "bright-cyan", "bright-magenta", "bright-yellow", "bright-green",
  "bright-blue", "bright-red", "cyan", "magenta",
];

// ── derivation ─────────────────────────────────────────────────────────

export function enterProto(state: ViewerState): ProtoState | undefined {
  const trace = traceOfCursor(state);
  if (!trace) return undefined;
  const base: ProtoState = {
    view: "flame", traceLabel: trace.label, path: [trace], hideAdmin: true,
    spans: [], byName: [], colors: {}, rootStart: 0, rootEnd: 0, t0: 0, t1: 0,
    cursor: 0, scrollTop: 0, detailScroll: 0,
  };
  const derived = deriveView(base);
  return derived.spans.length > 0 ? derived : undefined;
}

/** Recompute rows/colors/extent for the current drill root. */
function deriveView(p: ProtoState): ProtoState {
  const root = p.path[p.path.length - 1];
  // Thread labels come from threadCreated events anywhere in the TRACE
  // (a drilled subtree's llm calls still belong to threads created above).
  const ctx: SpanContext = { threadLabels: threadLabelsOf(p.path[0]), enclosing: "" };
  const spans: ProtoSpan[] = [];
  collectSpans(root, 0, p.hideAdmin, spans, ctx);
  if (p.path.length > 1) {
    const rootSpan = makeSpan(root, 0, ctx);
    if (rootSpan) spans.unshift(rootSpan);
  }
  if (spans.length === 0) return { ...p, spans, byName: [], cursor: 0 };
  const rootStart = Math.min(...spans.map((s) => s.start));
  const rootEnd = Math.max(...spans.map((s) => s.end));
  const byName = groupByName(spans, rootEnd - rootStart);
  const colors: Record<string, string> = {};
  byName.forEach((row, i) => { colors[row.name] = PALETTE[i] ?? "gray"; });
  return {
    ...p, spans, byName, colors, rootStart, rootEnd,
    t0: rootStart, t1: rootEnd, cursor: 0, scrollTop: 0,
  };
}

function traceOfCursor(state: ViewerState): TreeNode | undefined {
  const byId: Record<string, TreeNode> = {};
  const index = (n: TreeNode) => { byId[n.id] = n; n.children.forEach(index); };
  state.roots.forEach(index);
  const traceId = byId[state.cursorId]?.traceId;
  return state.roots.find((r) => r.traceId === traceId) ?? state.roots[0];
}

/** What an llm span needs from its surroundings to name its group:
 *  thread labels (trace-wide) and the function/node the call sits in. */
type SpanContext = { threadLabels: Record<string, string>; enclosing: string };

/** threadId → label from every threadCreated event under `root`. NOTE for
 *  the real build: thread ids are NOT unique across subprocess trees (this
 *  trace has two threadCreated for id "1" — parent's "main"/"expertAgent"
 *  vs the subprocess's); last-wins is prototype-grade only. */
function threadLabelsOf(root: TreeNode): Record<string, string> {
  const labels: Record<string, string> = {};
  const walk = (n: TreeNode) => {
    const d = n.event?.data;
    if (d?.type === "threadCreated" && typeof d.label === "string" && d.label.length > 0) {
      labels[String(d.threadId)] = d.label;
    }
    n.children.forEach(walk);
  };
  walk(root);
  return labels;
}

function collectSpans(node: TreeNode, depth: number, hideAdmin: boolean, out: ProtoSpan[], ctx: SpanContext): void {
  for (const child of node.children) {
    if (child.nodeKind !== "span") continue;
    const hidden = hideAdmin && ADMIN_KINDS.includes(child.label);
    if (!hidden) {
      const s = makeSpan(child, depth, ctx);
      if (s) out.push(s);
    }
    const enclosing = enclosingNameFor(child) ?? ctx.enclosing;
    collectSpans(child, hidden ? depth : depth + 1, hideAdmin, out, { ...ctx, enclosing });
  }
}

/** The "function the call was made in", for llm calls with no thread
 *  label: the nearest enclosing tool (a subagent like codeAgent counts —
 *  tools and functions are the same thing) or node. */
function enclosingNameFor(span: TreeNode): string | undefined {
  if (span.label === "toolExecution" || span.label === "nodeExecution") {
    return nameOf(span);
  }
  return undefined;
}

function makeSpan(node: TreeNode, depth: number, ctx: SpanContext): ProtoSpan | undefined {
  const extent = spanExtent(node);
  if (!extent) return undefined;
  const childExtents = node.children
    .filter((c) => c.nodeKind === "span")
    .map(spanExtent)
    .filter((e): e is { start: number; end: number } => e !== undefined)
    .map((e): [number, number] => [e.start, e.end]);
  const selfIntervals = subtractIntervals([extent.start, extent.end], childExtents);
  return {
    node,
    name: groupNameOf(node, ctx),
    label: labelOf(node),
    detail: detailOf(node),
    kind: node.label,
    depth,
    start: extent.start,
    end: extent.end,
    selfIntervals,
    selfMs: selfIntervals.reduce((s, [a, b]) => s + (b - a), 0),
  };
}

function subtractIntervals(base: [number, number], subs: [number, number][]): [number, number][] {
  const sorted = [...subs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cursor = base[0];
  for (const [s, e] of sorted) {
    if (e <= cursor) continue;
    if (s > base[1]) break;
    if (s > cursor) out.push([cursor, Math.min(s, base[1])]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < base[1]) out.push([cursor, base[1]]);
  return out;
}

/** Envelope over the span's leaf events, same rule tree.ts uses for
 *  duration: start = min(timestamp - timeTaken), end = max(timestamp). */
function spanExtent(node: TreeNode): { start: number; end: number } | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const walk = (n: TreeNode) => {
    if (n.event) {
      const ts = Date.parse(n.event.data.timestamp);
      if (Number.isFinite(ts)) {
        const taken = typeof n.event.data.timeTaken === "number" ? n.event.data.timeTaken : 0;
        start = Math.min(start, ts - taken);
        end = Math.max(end, ts);
      }
    }
    n.children.forEach(walk);
  };
  walk(node);
  if (!Number.isFinite(start)) return undefined;
  return { start, end: Math.max(end, start) };
}

function firstLeaf(node: TreeNode, want: (t: string) => boolean): TreeNode | undefined {
  let found: TreeNode | undefined;
  const walk = (n: TreeNode) => {
    if (found) return;
    if (n.event && want(n.event.data.type)) found = n;
    n.children.forEach(walk);
  };
  walk(node);
  return found;
}

/** Grouping/color key. For llm calls (owner decision): the THREAD LABEL
 *  when one exists (`llm(codingAgent)`), else the enclosing function, else
 *  the model. Non-llm spans group by their plain name. */
function groupNameOf(node: TreeNode, ctx: SpanContext): string {
  if (node.label !== "llmCall") return nameOf(node);
  const leaf = firstLeaf(node, (t) => t === "promptCompletion" || t === "promptStart");
  const threadId = leaf?.event?.data.threadId;
  const label = threadId !== undefined ? ctx.threadLabels[String(threadId)] : undefined;
  const key = label ?? (ctx.enclosing || undefined);
  return key ? `llm(${key})` : nameOf(node);
}

function nameOf(node: TreeNode): string {
  if (node.label === "toolExecution") {
    const l = firstLeaf(node, (t) => t === "toolCallStart" || t === "toolCall");
    return String(l?.event?.data.toolName ?? "tool?");
  }
  if (node.label === "llmCall") {
    const l = firstLeaf(node, (t) => t === "promptCompletion" || t === "promptStart");
    // model arrives with embedded quotes, e.g. `"claude-sonnet-5"` — strip.
    const model = String(l?.event?.data.model ?? "?").replace(/"/g, "");
    return `llm(${model})`;
  }
  if (node.label === "nodeExecution") {
    const l = firstLeaf(node, (t) => t === "enterNode");
    return `node ${String(l?.event?.data.node ?? l?.event?.data.nodeId ?? "?")}`;
  }
  return node.label;
}

/** Flame row text. LLM calls show what was ASKED, not which model — the
 *  model name ate the whole gutter and identified nothing (screenshot
 *  feedback); the model still lives in byName rows, the footer, and the
 *  detail screen. */
function labelOf(node: TreeNode): string {
  if (node.label === "llmCall") {
    const snippet = promptSnippet(node);
    return snippet ? `llm · ${snippet}` : "llm";
  }
  return nameOf(node);
}

/** First words of the llm call's prompt: the LAST user message (in a tool
 *  loop that is the round's actual input; for a subagent it is the task). */
function promptSnippet(node: TreeNode): string {
  const l = firstLeaf(node, (t) => t === "promptCompletion");
  const messages = l?.event?.data.messages;
  if (!Array.isArray(messages)) return "";
  const userMessages = messages.filter(
    (m: { role?: string; content?: unknown }) => m.role === "user" && typeof m.content === "string",
  );
  const last = userMessages[userMessages.length - 1];
  return last ? oneLine(String(last.content)) : "";
}

/** Per-call extra shown after the label. Tools: the first string argument
 *  (a bash command, a file path, a subagent's task). LLM calls: tokens +
 *  cost — the "is this worth digging into" number. */
function detailOf(node: TreeNode): string {
  if (node.label === "toolExecution") {
    const l = firstLeaf(node, (t) => t === "toolCallStart" || t === "toolCall");
    const args = l?.event?.data.args;
    if (args && typeof args === "object") {
      const firstString = Object.values(args).find((v) => typeof v === "string");
      if (typeof firstString === "string") return oneLine(firstString);
    }
    return "";
  }
  if (node.label === "llmCall") {
    const parts: string[] = [];
    if (node.tokens) parts.push(`${Math.round(node.tokens / 1000)}k tok`);
    if (node.cost) parts.push(`$${node.cost.toFixed(2)}`);
    return parts.join(" ");
  }
  return "";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function groupByName(spans: ProtoSpan[], rootMs: number): NameRow[] {
  const by: Record<string, NameRow> = {};
  for (const s of spans) {
    by[s.name] ??= { name: s.name, kind: s.kind, count: 0, totalMs: 0, share: 0, spans: [] };
    by[s.name].count += 1;
    by[s.name].totalMs += s.selfMs;
    by[s.name].spans.push(s);
  }
  const rows = Object.values(by).sort((a, b) => b.totalMs - a.totalMs);
  for (const r of rows) r.share = rootMs > 0 ? r.totalMs / rootMs : 0;
  return rows;
}

/** "main » codeAgent » llm" — where a call sits, for occurrence rows. */
function contextOf(target: TreeNode, root: TreeNode): string {
  const chain: TreeNode[] = [];
  const find = (n: TreeNode, trail: TreeNode[]): boolean => {
    if (n === target) { chain.push(...trail); return true; }
    return n.children.some((c) => find(c, [...trail, n]));
  };
  find(root, []);
  const names = chain
    .filter((n) => n.nodeKind === "span")
    .map((n) => (n.label === "llmCall" ? "llm" : nameOf(n)));
  return names.join(" » ");
}

// ── keys ───────────────────────────────────────────────────────────────

export function protoHandleKey(p: ProtoState, ev: KeyEvent): ProtoState {
  if (p.view === "detail") return detailKeys(p, ev);
  if (p.view === "occ") return occKeys(p, ev);
  const rows = p.view === "flame" ? p.spans.length : p.byName.length;
  const window = p.t1 - p.t0;
  if (ev.key === "t") {
    if (p.view === "flame") return deriveView({ ...p, view: "byName" });
    return { ...p, exit: true };
  }
  if (ev.key === "escape") return { ...p, exit: true };
  if (ev.key === "up" || ev.key === "k") return { ...p, cursor: Math.max(0, p.cursor - 1) };
  if (ev.key === "down" || ev.key === "j") return { ...p, cursor: Math.min(rows - 1, p.cursor + 1) };
  if (ev.key === "enter" || ev.key === "return" || ev.key === "right") {
    if (p.view === "byName") return openOccurrences(p);
    return drillOrDetail(p);
  }
  if (ev.key === "left") return drillOut(p);
  if (ev.key === "d") {
    const sel = p.view === "flame" ? p.spans[p.cursor] : p.byName[p.cursor]?.spans[0];
    return sel ? openDetail(p, sel, p.view) : p;
  }
  if (ev.key === "o") {
    const target = p.view === "flame" ? p.spans[p.cursor] : p.byName[p.cursor]?.spans[0];
    if (target) return { ...p, jumpToSpanId: target.node.id, exit: true };
    return p;
  }
  if (ev.key === "h") return deriveView({ ...p, hideAdmin: !p.hideAdmin });
  if (ev.key === "+" || ev.key === "=") return zoomAround(p, window / 2);
  if (ev.key === "-") return zoomAround(p, Math.min(window * 2, p.rootEnd - p.rootStart));
  if (ev.key === "[") return pan(p, -window / 4);
  if (ev.key === "]") return pan(p, window / 4);
  if (ev.key === "0") return { ...p, t0: p.rootStart, t1: p.rootEnd };
  return p;
}

function occKeys(p: ProtoState, ev: KeyEvent): ProtoState {
  const rows = p.occSpans?.length ?? 0;
  if (ev.key === "escape" || ev.key === "left") {
    return { ...p, view: "byName", occName: undefined, occSpans: undefined, cursor: 0, scrollTop: 0 };
  }
  if (ev.key === "up" || ev.key === "k") return { ...p, cursor: Math.max(0, p.cursor - 1) };
  if (ev.key === "down" || ev.key === "j") return { ...p, cursor: Math.min(rows - 1, p.cursor + 1) };
  if (ev.key === "enter" || ev.key === "return" || ev.key === "right" || ev.key === "d") {
    const sel = p.occSpans?.[p.cursor];
    if (!sel) return p;
    if (ev.key !== "d" && sel.node.children.some((c) => c.nodeKind === "span")) {
      return deriveView({ ...p, view: "flame", path: [...p.path, sel.node], occName: undefined, occSpans: undefined });
    }
    return openDetail(p, sel, "occ");
  }
  if (ev.key === "o") {
    const sel = p.occSpans?.[p.cursor];
    return sel ? { ...p, jumpToSpanId: sel.node.id, exit: true } : p;
  }
  if (ev.key === "t") return { ...p, exit: true };
  return p;
}

function detailKeys(p: ProtoState, ev: KeyEvent): ProtoState {
  const lines = p.detailLines?.length ?? 0;
  if (ev.key === "escape" || ev.key === "left") {
    return { ...p, view: p.detailReturn ?? "flame", detailLines: undefined, detailTitle: undefined, detailScroll: 0 };
  }
  if (ev.key === "up" || ev.key === "k") return { ...p, detailScroll: Math.max(0, p.detailScroll - 1) };
  if (ev.key === "down" || ev.key === "j") return { ...p, detailScroll: Math.min(Math.max(0, lines - 5), p.detailScroll + 1) };
  if (ev.key === "t") return { ...p, exit: true };
  return p;
}

/** byName Enter: list every call of the selected name, chronologically,
 *  each with the context of where it came from. */
function openOccurrences(p: ProtoState): ProtoState {
  const row = p.byName[p.cursor];
  if (!row) return p;
  const occ = [...row.spans].sort((a, b) => a.start - b.start);
  return { ...p, view: "occ", occName: row.name, occSpans: occ, cursor: 0, scrollTop: 0 };
}

/** Flame Enter: drill into a span with children; open detail for a leaf. */
function drillOrDetail(p: ProtoState): ProtoState {
  const target = p.spans[p.cursor];
  if (!target) return p;
  const currentRoot = p.path[p.path.length - 1];
  if (target.node !== currentRoot && target.node.children.some((c) => c.nodeKind === "span")) {
    return deriveView({ ...p, view: "flame", path: [...p.path, target.node] });
  }
  return openDetail(p, target, "flame");
}

function drillOut(p: ProtoState): ProtoState {
  if (p.path.length <= 1) return p;
  return deriveView({ ...p, path: p.path.slice(0, -1) });
}

// ── detail screen content ──────────────────────────────────────────────

function openDetail(p: ProtoState, s: ProtoSpan, from: ProtoView): ProtoState {
  const lines: string[] = [];
  lines.push(String(s.node.summary ?? s.name));
  lines.push(`start +${fmtMs(s.start - p.rootStart)}   duration ${fmtMs(s.end - s.start)}   self ${fmtMs(s.selfMs)}`);
  lines.push("");
  const prompt = firstLeaf(s.node, (t) => t === "promptCompletion");
  if (prompt?.event) {
    const d = prompt.event.data;
    lines.push(`model: ${String(d.model ?? "?").replace(/"/g, "")}`);
    const usage = d.usage ?? {};
    lines.push(`tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out   cost: $${(d.cost?.totalCost ?? 0).toFixed(4)}`);
    lines.push("");
    lines.push("── transcript ──");
    const messages = Array.isArray(d.messages) ? d.messages : [];
    const completion = d.completion?.output || d.completion?.toolCalls?.length
      ? [{ role: "assistant", content: d.completion.output, toolCalls: d.completion.toolCalls }]
      : [];
    lines.push(...formatConversation([...messages, ...completion]));
  } else {
    const tool = firstLeaf(s.node, (t) => t === "toolCallStart" || t === "toolCall");
    if (tool?.event) {
      lines.push("── call ──");
      lines.push(...JSON.stringify(tool.event.data, null, 2).split("\n"));
    } else if (s.node.event) {
      lines.push(...JSON.stringify(s.node.event.data, null, 2).split("\n"));
    }
  }
  return { ...p, view: "detail", detailTitle: s.label, detailLines: lines, detailScroll: 0, detailReturn: from };
}

function zoomAround(p: ProtoState, newWindow: number): ProtoState {
  const sel = p.view === "flame" ? p.spans[p.cursor] : p.byName[p.cursor]?.spans[0];
  const center = sel ? (sel.start + sel.end) / 2 : (p.t0 + p.t1) / 2;
  let t0 = center - newWindow / 2;
  let t1 = center + newWindow / 2;
  if (t0 < p.rootStart) { t1 += p.rootStart - t0; t0 = p.rootStart; }
  if (t1 > p.rootEnd) { t0 -= t1 - p.rootEnd; t1 = p.rootEnd; }
  return { ...p, t0: Math.max(t0, p.rootStart), t1: Math.min(t1, p.rootEnd) };
}

function pan(p: ProtoState, delta: number): ProtoState {
  const window = p.t1 - p.t0;
  let t0 = p.t0 + delta;
  if (t0 < p.rootStart) t0 = p.rootStart;
  if (t0 + window > p.rootEnd) t0 = p.rootEnd - window;
  return { ...p, t0, t1: t0 + window };
}

/** Applied when leaving via `o`: focus + reveal the chosen span. */
export function protoExitToTree(state: ViewerState, p: ProtoState): ViewerState {
  if (!p.jumpToSpanId) return state;
  const expanded = expandAncestorsOf(state, [p.jumpToSpanId]);
  return { ...expanded, cursorId: p.jumpToSpanId };
}

// ── rendering ──────────────────────────────────────────────────────────

const FLAME_GUTTER = 48;
const NAME_GUTTER = 28;

export function renderProto(p: ProtoState, viewport: { rows: number; cols: number }): Element {
  if (p.view === "detail") return renderDetail(p, viewport);
  if (p.view === "occ") return renderOccurrences(p, viewport);
  const gutter = p.view === "flame" ? FLAME_GUTTER : NAME_GUTTER;
  const statsW = p.view === "byName" ? 20 : 16;
  const axisW = Math.max(10, viewport.cols - gutter - statsW - 1);
  const bodyRows = viewport.rows - 4; // header(2) + footer(2)

  // keep the cursor on screen (recomputed per frame; rough but enough here)
  let scrollTop = p.scrollTop;
  if (p.cursor < scrollTop) scrollTop = p.cursor;
  if (p.cursor >= scrollTop + bodyRows) scrollTop = p.cursor - bodyRows + 1;
  p.scrollTop = scrollTop;

  const items = p.view === "flame" ? p.spans : p.byName;
  const { element: body } = scrollList({
    items: items as unknown[],
    cursorIdx: p.cursor,
    scrollTop,
    viewportRows: bodyRows,
    renderItem: (item, isCursor) =>
      p.view === "flame"
        ? flameRow(p, item as ProtoSpan, isCursor, axisW, statsW)
        : nameRow(p, item as NameRow, isCursor, axisW),
  });

  return column({ justifyContent: "flex-start" },
    line(headerLine(p), { fg: "bright-white" }),
    line(axisHeader(p, gutter, axisW), { fg: "gray" }),
    body,
    line(selectionInfo(p), { fg: "bright-white" }),
    line("t view  ↑↓ select  Enter/→ drill  ← out  d detail  o tree  +/- zoom  [ ] pan  0 reset  h admin  Esc back", { fg: "gray" }),
  );
}

function headerLine(p: ProtoState): string {
  const drillCrumbs = p.path.length > 1
    ? "  » " + p.path.slice(1).map((n) => nameOf(n)).join(" » ")
    : "";
  return `TIMELINE [${p.view}]  ${p.traceLabel}${drillCrumbs}  ${fmtMs(p.rootEnd - p.rootStart)}` +
    (p.hideAdmin ? "" : "  [admin spans shown]") +
    (p.t0 !== p.rootStart || p.t1 !== p.rootEnd ? `  (zoom ${fmtMs(p.t0 - p.rootStart)}–${fmtMs(p.t1 - p.rootStart)})` : "");
}

function renderOccurrences(p: ProtoState, viewport: { rows: number; cols: number }): Element {
  const occ = p.occSpans ?? [];
  const root = p.path[p.path.length - 1];
  const gutter = Math.min(64, Math.floor(viewport.cols * 0.55));
  const statsW = 10;
  const axisW = Math.max(10, viewport.cols - gutter - statsW - 1);
  const bodyRows = viewport.rows - 4;
  let scrollTop = p.scrollTop;
  if (p.cursor < scrollTop) scrollTop = p.cursor;
  if (p.cursor >= scrollTop + bodyRows) scrollTop = p.cursor - bodyRows + 1;
  p.scrollTop = scrollTop;

  const { element: body } = scrollList({
    items: occ as unknown[],
    cursorIdx: p.cursor,
    scrollTop,
    viewportRows: bodyRows,
    renderItem: (item, isCursor) => {
      const s = item as ProtoSpan;
      const idx = occ.indexOf(s) + 1;
      // The part of the path SHARED by every occurrence says nothing about
      // this one — show only the distinguishing tail (full path in header).
      const contexts = occ.map((o) => contextOf((o as ProtoSpan).node, root));
      const shared = commonPrefix(contexts);
      const context = contexts[occ.indexOf(s)].slice(shared.length) || "·";
      const text = s.detail ? `${context} · ${s.detail}` : context;
      const label = clip(`#${String(idx).padStart(2)} ${text}`, gutter - 3);
      const bar = barCells(axisW, [[s.start, s.end]], p);
      const marker = isCursor ? "▶ " : "  ";
      return line(`${marker}${pad(label, gutter - 2)}${bar}${fmtMs(s.end - s.start).padStart(statsW - 1)}`,
        { fg: isCursor ? "bright-white" : p.colors[s.name] });
    },
  });

  const sharedPath = commonPrefix(occ.map((o) => contextOf(o.node, root)));
  return column({ justifyContent: "flex-start" },
    line(`TIMELINE [occurrences]  ${p.occName}  — ${occ.length} call(s)` +
      (sharedPath ? `  (all under ${sharedPath.replace(/ » $/, "")})` : ""), { fg: "bright-white" }),
    line(axisHeader(p, gutter, axisW), { fg: "gray" }),
    body,
    line(selectionInfoOcc(p), { fg: "bright-white" }),
    line("↑↓ select  Enter/→ drill or detail  d detail  o tree  ←/Esc back to byName", { fg: "gray" }),
  );
}

function renderDetail(p: ProtoState, viewport: { rows: number; cols: number }): Element {
  const all = (p.detailLines ?? []).flatMap((l) => wrap(l, viewport.cols - 2));
  const bodyRows = viewport.rows - 3;
  const visible = all.slice(p.detailScroll, p.detailScroll + bodyRows);
  return column({ justifyContent: "flex-start" },
    line(`DETAIL  ${p.detailTitle ?? ""}`, { fg: "bright-white" }),
    ...visible.map((l) => line(l)),
    line(`↑↓ scroll (${p.detailScroll + 1}–${Math.min(all.length, p.detailScroll + bodyRows)} of ${all.length})  ←/Esc back`, { fg: "gray" }),
  );
}

function axisHeader(p: ProtoState, gutter: number, axisW: number): string {
  const left = fmtMs(p.t0 - p.rootStart);
  const right = fmtMs(p.t1 - p.rootStart);
  const mid = fmtMs((p.t0 + p.t1) / 2 - p.rootStart);
  const half = Math.floor(axisW / 2);
  const axis = pad(left, half) + pad(mid, Math.max(0, axisW - half - right.length)) + right;
  return " ".repeat(gutter) + axis;
}

function flameRow(p: ProtoState, s: ProtoSpan, isCursor: boolean, axisW: number, statsW: number): Element {
  const indent = "  ".repeat(Math.min(s.depth, 10));
  const text = s.detail ? `${s.label} · ${s.detail}` : s.label;
  const label = clip(`${indent}${text}`, FLAME_GUTTER - 3);
  const bar = barCells(axisW, [[s.start, s.end]], p);
  const dur = s.end - s.start;
  const stats = (s.selfMs < dur * 0.95
    ? `${fmtMs(dur)}/${fmtMs(s.selfMs)}`
    : fmtMs(dur)).padStart(statsW - 1);
  const marker = isCursor ? "▶ " : "  ";
  return line(`${marker}${pad(label, FLAME_GUTTER - 2)}${bar}${stats}`,
    { fg: isCursor ? "bright-white" : p.colors[s.name] });
}

function nameRow(p: ProtoState, r: NameRow, isCursor: boolean, axisW: number): Element {
  const label = clip(r.name, NAME_GUTTER - 3);
  const bar = barCells(axisW, r.spans.flatMap((s) => s.selfIntervals), p);
  const stats = `${String(r.count).padStart(4)}× ${fmtMs(r.totalMs).padStart(7)} ${Math.round(r.share * 100).toString().padStart(3)}%`;
  const marker = isCursor ? "▶ " : "  ";
  return line(`${marker}${pad(label, NAME_GUTTER - 2)}${bar} ${stats}`,
    { fg: isCursor ? "bright-white" : p.colors[r.name] });
}

/** Paint intervals onto axisW cells. The shade means how BUSY the slice
 *  was — what fraction of that cell's time window the function actually
 *  ran: · none, ░ ≤25%, ▒ ≤50%, ▓ ≤90%, █ nearly all. (Count-based
 *  shading made 62 tiny bash calls read as "heavy overlap".) Every
 *  interval inside the window still paints at least one cell. */
function barCells(axisW: number, intervals: [number, number][], p: ProtoState): string {
  const covered = new Array(axisW).fill(0);
  const window = p.t1 - p.t0 || 1;
  const cellMs = window / axisW;
  for (const [start, end] of intervals) {
    if (end < p.t0 || start > p.t1) continue;
    const a = Math.max(0, Math.floor(((start - p.t0) / window) * axisW));
    const b = Math.min(axisW - 1, Math.max(a, Math.ceil(((end - p.t0) / window) * axisW) - 1));
    for (let i = a; i <= b; i++) {
      const cellStart = p.t0 + i * cellMs;
      const cellEnd = cellStart + cellMs;
      const overlap = Math.min(end, cellEnd) - Math.max(start, cellStart);
      covered[i] += Math.max(overlap, cellMs * 0.05); // floor: stay visible
    }
  }
  return covered.map((ms: number) => {
    const frac = ms / cellMs;
    if (frac <= 0) return "·";
    if (frac <= 0.25) return "░";
    if (frac <= 0.5) return "▒";
    if (frac <= 0.9) return "▓";
    return "█";
  }).join("");
}

function selectionInfo(p: ProtoState): string {
  if (p.view === "flame") {
    const s = p.spans[p.cursor];
    if (!s) return "";
    return `${s.node.summary}  ·  start +${fmtMs(s.start - p.rootStart)}  self ${fmtMs(s.selfMs)}`;
  }
  const r = p.byName[p.cursor];
  if (!r) return "";
  // The model left the llm group key (groups are thread labels now), so
  // name the models here — still one glance to see the model mix.
  const models = [...new Set(
    r.spans
      .filter((s) => s.kind === "llmCall")
      .map((s) => nameOf(s.node).replace(/^llm\(|\)$/g, "")),
  )];
  const modelInfo = models.length > 0 ? `  models: ${models.join(", ")}` : "";
  return `${r.name}  [${r.kind}]  ${r.count} call(s)  self-time total ${fmtMs(r.totalMs)}  ${Math.round(r.share * 100)}% of view${modelInfo}`;
}

function selectionInfoOcc(p: ProtoState): string {
  const s = p.occSpans?.[p.cursor];
  if (!s) return "";
  return `${s.node.summary}  ·  start +${fmtMs(s.start - p.rootStart)}  self ${fmtMs(s.selfMs)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function clip(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  // cut at a path-segment boundary so we never split a name mid-word
  const at = prefix.lastIndexOf(" » ");
  return at === -1 ? "" : prefix.slice(0, at + 3);
}

function wrap(s: string, w: number): string[] {
  if (s.length <= w) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
  return out;
}
