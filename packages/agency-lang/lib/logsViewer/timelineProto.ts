// ═══════════════════════════════════════════════════════════════════════
// PROTOTYPE — THROWAWAY CODE. Do not ship, do not test, do not polish.
//
// Question this answers: what should the timeline views of a single run
// look like in the terminal, and how should drill-down / zoom / labels
// behave? Two variants, cycled with `t` from the normal tree view:
//   tree → flame (row per call, indented, drill with Enter/→/←)
//        → byName (row per function, repeated bars + count/total/share)
//        → tree
// Everything lives in this one file; run.ts has a small marked hook.
// The real implementation will be rebuilt properly from what we learn.
// ═══════════════════════════════════════════════════════════════════════
import { column, line } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import { scrollList } from "../tui/scrollList.js";
import type { KeyEvent } from "../tui/input/types.js";
import { expandAncestorsOf } from "./search.js";
import type { TreeNode, ViewerState } from "./types.js";

type ProtoSpan = {
  node: TreeNode;
  name: string;       // grouping key + color key, e.g. `llm(claude-sonnet-5)`, `bash`
  detail: string;     // what THIS call was doing, e.g. the bash command
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

export type ProtoState = {
  view: "flame" | "byName";
  traceLabel: string;
  path: TreeNode[];         // drill stack; last entry is the current root
  hideAdmin: boolean;
  // everything below is derived from the current root (deriveView)
  spans: ProtoSpan[];
  byName: NameRow[];
  colors: Record<string, string>;
  rootStart: number;
  rootEnd: number;
  t0: number;
  t1: number;
  cursor: number;
  scrollTop: number;
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
    cursor: 0, scrollTop: 0,
  };
  const derived = deriveView(base);
  return derived.spans.length > 0 ? derived : undefined;
}

/** Recompute rows/colors/extent for the current drill root. */
function deriveView(p: ProtoState): ProtoState {
  const root = p.path[p.path.length - 1];
  const spans: ProtoSpan[] = [];
  collectSpans(root, 0, p.hideAdmin, spans);
  // Drilling into a span: the root itself is a row too (depth 0 context).
  if (p.path.length > 1) {
    const rootSpan = makeSpan(root, 0);
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

function collectSpans(node: TreeNode, depth: number, hideAdmin: boolean, out: ProtoSpan[]): void {
  for (const child of node.children) {
    if (child.nodeKind !== "span") continue;
    const hidden = hideAdmin && ADMIN_KINDS.includes(child.label);
    if (!hidden) {
      const s = makeSpan(child, depth);
      if (s) out.push(s);
    }
    collectSpans(child, hidden ? depth : depth + 1, hideAdmin, out);
  }
}

function makeSpan(node: TreeNode, depth: number): ProtoSpan | undefined {
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
    name: nameOf(node),
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

/** What this one call was doing — the thing the row label alone cannot
 *  say. Tools: the first string argument (a bash command, a file path, a
 *  subagent's task). LLM calls: tokens + cost. */
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

// ── keys ───────────────────────────────────────────────────────────────

export function protoHandleKey(p: ProtoState, ev: KeyEvent): ProtoState {
  const rows = p.view === "flame" ? p.spans.length : p.byName.length;
  const window = p.t1 - p.t0;
  if (ev.key === "t") {
    if (p.view === "flame") return deriveView({ ...p, view: "byName" });
    return { ...p, exit: true };
  }
  if (ev.key === "escape") return { ...p, exit: true };
  if (ev.key === "up" || ev.key === "k") return { ...p, cursor: Math.max(0, p.cursor - 1) };
  if (ev.key === "down" || ev.key === "j") return { ...p, cursor: Math.min(rows - 1, p.cursor + 1) };
  if (ev.key === "enter" || ev.key === "return" || ev.key === "right") return drillIn(p);
  if (ev.key === "left") return drillOut(p);
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

/** Re-root the flame on the selected span: only it and its descendants
 *  remain, and the time axis rescales to its extent. From byName, drill
 *  into the selected name's longest call. */
function drillIn(p: ProtoState): ProtoState {
  const target = p.view === "flame"
    ? p.spans[p.cursor]
    : longestSpan(p.byName[p.cursor]?.spans);
  if (!target) return p;
  const currentRoot = p.path[p.path.length - 1];
  if (target.node === currentRoot) return p;
  if (!target.node.children.some((c) => c.nodeKind === "span")) return p;
  return deriveView({ ...p, view: "flame", path: [...p.path, target.node] });
}

function drillOut(p: ProtoState): ProtoState {
  if (p.path.length <= 1) return p;
  return deriveView({ ...p, path: p.path.slice(0, -1) });
}

function longestSpan(spans: ProtoSpan[] | undefined): ProtoSpan | undefined {
  if (!spans || spans.length === 0) return undefined;
  return [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
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

  const drillCrumbs = p.path.length > 1
    ? "  » " + p.path.slice(1).map((n) => nameOf(n)).join(" » ")
    : "";
  return column({ justifyContent: "flex-start" },
    line(`TIMELINE [${p.view}]  ${p.traceLabel}${drillCrumbs}  ${fmtMs(p.rootEnd - p.rootStart)}` +
      (p.hideAdmin ? "" : "  [admin spans shown]") +
      (p.t0 !== p.rootStart || p.t1 !== p.rootEnd ? `  (zoom ${fmtMs(p.t0 - p.rootStart)}–${fmtMs(p.t1 - p.rootStart)})` : ""),
      { fg: "bright-white" }),
    line(axisHeader(p, gutter, axisW), { fg: "gray" }),
    body,
    line(selectionInfo(p), { fg: "bright-white" }),
    line("t view  ↑↓ select  Enter/→ drill in  ← out  o open in tree  +/- zoom  [ ] pan  0 reset  h admin  Esc back", { fg: "gray" }),
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
  const text = s.detail ? `${s.name} · ${s.detail}` : s.name;
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

/** Paint intervals onto axisW cells. 0 hits = "·", 1 = "█", 2+ = "▓"
 *  (overlap from concurrent calls of the same name under fork). Every
 *  interval inside the window paints at least one cell. */
function barCells(axisW: number, intervals: [number, number][], p: ProtoState): string {
  const counts = new Array(axisW).fill(0);
  const window = p.t1 - p.t0 || 1;
  for (const [start, end] of intervals) {
    if (end < p.t0 || start > p.t1) continue;
    const a = Math.max(0, Math.floor(((start - p.t0) / window) * axisW));
    const b = Math.min(axisW - 1, Math.max(a, Math.ceil(((end - p.t0) / window) * axisW) - 1));
    for (let i = a; i <= b; i++) counts[i] += 1;
  }
  return counts.map((c: number) => (c === 0 ? "·" : c === 1 ? "█" : "▓")).join("");
}

function selectionInfo(p: ProtoState): string {
  if (p.view === "flame") {
    const s = p.spans[p.cursor];
    if (!s) return "";
    // node.summary is the tree view's precomputed line: label, identifying
    // detail, and metrics (duration, tokens, cost).
    return `${s.node.summary}  ·  start +${fmtMs(s.start - p.rootStart)}  self ${fmtMs(s.selfMs)}`;
  }
  const r = p.byName[p.cursor];
  if (!r) return "";
  return `${r.name}  [${r.kind}]  ${r.count} call(s)  self-time total ${fmtMs(r.totalMs)}  ${Math.round(r.share * 100)}% of view`;
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
