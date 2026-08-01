// ═══════════════════════════════════════════════════════════════════════
// PROTOTYPE — THROWAWAY CODE. Do not ship, do not test, do not polish.
//
// Question this answers: what should the timeline views of a single run
// look like in the terminal, and how should cursor / zoom / jump-to-tree
// behave? Two variants, cycled with `t` from the normal tree view:
//   tree → flame (row per call, indented) → byName (row per function,
//   repeated bars + count/total/share) → tree
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
  id: string;
  name: string;
  kind: string;
  depth: number;
  start: number;
  end: number;
  // Envelope minus the direct child spans: the time this span spent
  // itself, not waiting on nested work. The learning that forced this:
  // the top-level llmCall span envelopes the whole tool loop, so raw
  // envelopes credited "llm(sonnet)" with 193% of a run.
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

export type ProtoState = {
  view: "flame" | "byName";
  traceLabel: string;
  spans: ProtoSpan[];       // DFS order (flame rows)
  byName: NameRow[];        // grouped rows, sorted by totalMs desc
  colors: Record<string, string>;
  traceStart: number;
  traceEnd: number;
  t0: number;               // zoom window
  t1: number;
  cursor: number;
  scrollTop: number;
  // set by Enter: leave the prototype and focus this span in the tree
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
  const spans: ProtoSpan[] = [];
  collectSpans(trace, 0, spans);
  if (spans.length === 0) return undefined;
  const traceStart = Math.min(...spans.map((s) => s.start));
  const traceEnd = Math.max(...spans.map((s) => s.end));
  const byName = groupByName(spans, traceEnd - traceStart);
  const colors: Record<string, string> = {};
  byName.forEach((row, i) => { colors[row.name] = PALETTE[i] ?? "gray"; });
  return {
    view: "flame", traceLabel: trace.label, spans, byName, colors,
    traceStart, traceEnd, t0: traceStart, t1: traceEnd,
    cursor: 0, scrollTop: 0,
  };
}

function traceOfCursor(state: ViewerState): TreeNode | undefined {
  const byId: Record<string, TreeNode> = {};
  const index = (n: TreeNode) => { byId[n.id] = n; n.children.forEach(index); };
  state.roots.forEach(index);
  const traceId = byId[state.cursorId]?.traceId;
  return state.roots.find((r) => r.traceId === traceId) ?? state.roots[0];
}

function collectSpans(node: TreeNode, depth: number, out: ProtoSpan[]): void {
  for (const child of node.children) {
    if (child.nodeKind !== "span") continue;
    const extent = spanExtent(child);
    if (extent) {
      const childExtents = child.children
        .filter((c) => c.nodeKind === "span")
        .map(spanExtent)
        .filter((e): e is { start: number; end: number } => e !== undefined)
        .map((e): [number, number] => [e.start, e.end]);
      const selfIntervals = subtractIntervals([extent.start, extent.end], childExtents);
      out.push({
        id: child.id,
        name: nameOf(child),
        kind: child.label,
        depth,
        start: extent.start,
        end: extent.end,
        selfIntervals,
        selfMs: selfIntervals.reduce((s, [a, b]) => s + (b - a), 0),
      });
    }
    collectSpans(child, depth + 1, out);
  }
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

function nameOf(node: TreeNode): string {
  const leaf = (want: (t: string) => boolean): TreeNode | undefined => {
    let found: TreeNode | undefined;
    const walk = (n: TreeNode) => {
      if (found) return;
      if (n.event && want(n.event.data.type)) found = n;
      n.children.forEach(walk);
    };
    walk(node);
    return found;
  };
  if (node.label === "toolExecution") {
    const l = leaf((t) => t === "toolCallStart" || t === "toolCall");
    return String(l?.event?.data.toolName ?? "tool?");
  }
  if (node.label === "llmCall") {
    const l = leaf((t) => t === "promptCompletion");
    const model = String(l?.event?.data.model ?? "?");
    return `llm(${model})`;
  }
  if (node.label === "nodeExecution") {
    const l = leaf((t) => t === "enterNode");
    return `node ${String(l?.event?.data.node ?? l?.event?.data.nodeId ?? "?")}`;
  }
  return node.label;
}

function groupByName(spans: ProtoSpan[], traceMs: number): NameRow[] {
  const by: Record<string, NameRow> = {};
  for (const s of spans) {
    by[s.name] ??= { name: s.name, kind: s.kind, count: 0, totalMs: 0, share: 0, spans: [] };
    by[s.name].count += 1;
    by[s.name].totalMs += s.selfMs;
    by[s.name].spans.push(s);
  }
  const rows = Object.values(by).sort((a, b) => b.totalMs - a.totalMs);
  for (const r of rows) r.share = traceMs > 0 ? r.totalMs / traceMs : 0;
  return rows;
}

// ── keys ───────────────────────────────────────────────────────────────

export function protoHandleKey(p: ProtoState, ev: KeyEvent): ProtoState {
  const rows = p.view === "flame" ? p.spans.length : p.byName.length;
  const span = (p.t1 - p.t0);
  if (ev.key === "t") {
    if (p.view === "flame") return { ...p, view: "byName", cursor: 0, scrollTop: 0 };
    return { ...p, exit: true };
  }
  if (ev.key === "escape") return { ...p, exit: true };
  if (ev.key === "up" || ev.key === "k") return { ...p, cursor: Math.max(0, p.cursor - 1) };
  if (ev.key === "down" || ev.key === "j") return { ...p, cursor: Math.min(rows - 1, p.cursor + 1) };
  if (ev.key === "+" || ev.key === "=") return zoomAround(p, span / 2);
  if (ev.key === "-") return zoomAround(p, Math.min(span * 2, p.traceEnd - p.traceStart));
  if (ev.key === "left") return pan(p, -span / 4);
  if (ev.key === "right") return pan(p, span / 4);
  if (ev.key === "0") return { ...p, t0: p.traceStart, t1: p.traceEnd };
  if (ev.key === "enter" || ev.key === "return") {
    const target = p.view === "flame" ? p.spans[p.cursor] : p.byName[p.cursor]?.spans[0];
    if (target) return { ...p, jumpToSpanId: target.id, exit: true };
  }
  return p;
}

function zoomAround(p: ProtoState, newSpan: number): ProtoState {
  const sel = p.view === "flame" ? p.spans[p.cursor] : p.byName[p.cursor]?.spans[0];
  const center = sel ? (sel.start + sel.end) / 2 : (p.t0 + p.t1) / 2;
  let t0 = center - newSpan / 2;
  let t1 = center + newSpan / 2;
  if (t0 < p.traceStart) { t1 += p.traceStart - t0; t0 = p.traceStart; }
  if (t1 > p.traceEnd) { t0 -= t1 - p.traceEnd; t1 = p.traceEnd; }
  return { ...p, t0: Math.max(t0, p.traceStart), t1: Math.min(t1, p.traceEnd) };
}

function pan(p: ProtoState, delta: number): ProtoState {
  const span = p.t1 - p.t0;
  let t0 = p.t0 + delta;
  if (t0 < p.traceStart) t0 = p.traceStart;
  if (t0 + span > p.traceEnd) t0 = p.traceEnd - span;
  return { ...p, t0, t1: t0 + span };
}

/** Applied when leaving via Enter: focus + reveal the chosen span. */
export function protoExitToTree(state: ViewerState, p: ProtoState): ViewerState {
  if (!p.jumpToSpanId) return state;
  const expanded = expandAncestorsOf(state, [p.jumpToSpanId]);
  return { ...expanded, cursorId: p.jumpToSpanId };
}

// ── rendering ──────────────────────────────────────────────────────────

const GUTTER = 28;

export function renderProto(p: ProtoState, viewport: { rows: number; cols: number }): Element {
  const statsW = p.view === "byName" ? 20 : 9;
  const axisW = Math.max(10, viewport.cols - GUTTER - statsW - 1);
  const bodyRows = viewport.rows - 4; // header(2) + footer(2)

  const items = p.view === "flame" ? p.spans : p.byName;
  // keep the cursor on screen (recomputed per frame; rough but enough here)
  let scrollTop = p.scrollTop;
  if (p.cursor < scrollTop) scrollTop = p.cursor;
  if (p.cursor >= scrollTop + bodyRows) scrollTop = p.cursor - bodyRows + 1;
  p.scrollTop = scrollTop;
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
    line(`TIMELINE [${p.view}]  ${p.traceLabel}  ${fmtMs(p.traceEnd - p.traceStart)} total` +
      (p.t0 !== p.traceStart || p.t1 !== p.traceEnd ? `  (zoom ${fmtMs(p.t0 - p.traceStart)}–${fmtMs(p.t1 - p.traceStart)})` : ""),
      { fg: "bright-white" }),
    line(axisHeader(p, axisW), { fg: "gray" }),
    body,
    line(selectionInfo(p), { fg: "bright-white" }),
    line("t next view  ↑↓ select  +/- zoom  ←→ pan  0 reset  Enter → tree  Esc back", { fg: "gray" }),
  );
}

function axisHeader(p: ProtoState, axisW: number): string {
  const left = fmtMs(p.t0 - p.traceStart);
  const right = fmtMs(p.t1 - p.traceStart);
  const mid = fmtMs((p.t0 + p.t1) / 2 - p.traceStart);
  const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const half = Math.floor(axisW / 2);
  const axis = pad(left, half) + pad(mid, axisW - half - right.length) + right;
  return " ".repeat(GUTTER) + axis;
}

function flameRow(p: ProtoState, s: ProtoSpan, isCursor: boolean, axisW: number, statsW: number): Element {
  const indent = "  ".repeat(Math.min(s.depth, 10));
  const label = clip(`${indent}${s.name}`, GUTTER - 3);
  const bar = barCells(axisW, [[s.start, s.end]], p);
  const dur = fmtMs(s.end - s.start).padStart(statsW - 2);
  const marker = isCursor ? "▶ " : "  ";
  return line(`${marker}${pad(label, GUTTER - 2)}${bar}${dur}`,
    { fg: isCursor ? "bright-white" : p.colors[s.name] });
}

function nameRow(p: ProtoState, r: NameRow, isCursor: boolean, axisW: number): Element {
  const label = clip(r.name, GUTTER - 3);
  const bar = barCells(axisW, r.spans.flatMap((s) => s.selfIntervals), p);
  const stats = `${String(r.count).padStart(4)}× ${fmtMs(r.totalMs).padStart(7)} ${Math.round(r.share * 100).toString().padStart(3)}%`;
  const marker = isCursor ? "▶ " : "  ";
  return line(`${marker}${pad(label, GUTTER - 2)}${bar} ${stats}`,
    { fg: isCursor ? "bright-white" : p.colors[r.name] });
}

/** Paint intervals onto axisW cells. 0 hits = "·", 1 = "█", 2+ = "▓"
 *  (overlap from concurrent calls of the same name under fork). Every
 *  interval inside the window paints at least one cell. */
function barCells(axisW: number, intervals: [number, number][], p: ProtoState): string {
  const counts = new Array(axisW).fill(0);
  const span = p.t1 - p.t0 || 1;
  for (const [start, end] of intervals) {
    if (end < p.t0 || start > p.t1) continue;
    const a = Math.max(0, Math.floor(((start - p.t0) / span) * axisW));
    const b = Math.min(axisW - 1, Math.max(a, Math.ceil(((end - p.t0) / span) * axisW) - 1));
    for (let i = a; i <= b; i++) counts[i] += 1;
  }
  return counts.map((c: number) => (c === 0 ? "·" : c === 1 ? "█" : "▓")).join("");
}

function selectionInfo(p: ProtoState): string {
  if (p.view === "flame") {
    const s = p.spans[p.cursor];
    if (!s) return "";
    return `${s.name}  [${s.kind}]  start +${fmtMs(s.start - p.traceStart)}  dur ${fmtMs(s.end - s.start)}  self ${fmtMs(s.selfMs)}`;
  }
  const r = p.byName[p.cursor];
  if (!r) return "";
  return `${r.name}  [${r.kind}]  ${r.count} call(s)  total ${fmtMs(r.totalMs)}  ${Math.round(r.share * 100)}% of run`;
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
