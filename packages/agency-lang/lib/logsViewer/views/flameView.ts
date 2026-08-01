// The flame view: one row per call, indented by nesting, on a shared time
// axis. Enter/→ re-roots on the selected span (drill); ← climbs out. Row
// labels say what each call was DOING — the last user message for llm
// calls, the first string argument for tools — never the model name,
// which identified nothing (prototype finding).
import { column, line, row } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { scrollList } from "../../tui/scrollList.js";
import {
  childEvent,
  durationColor,
  fmtDuration,
  lastUserMessage,
  spanDetail,
  stripQuotes,
  truncate,
} from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { groupSpans, spanDisplayName } from "../timeline/groups.js";
import type { Interval } from "../timeline/intervals.js";
import { ADMIN_KINDS, timelineSpans, type TimelineSpan } from "../timeline/spans.js";
import {
  AxisHeader,
  BarComponent,
  SelectionFooter,
  TimelineHeader,
  clipCell,
  fmtOffset,
  padCell,
  splitWidth,
} from "./shared.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

export const GROUP_PALETTE = [
  "bright-cyan", "bright-magenta", "bright-yellow", "bright-green",
  "bright-blue", "bright-red", "cyan", "magenta",
];

type FlameRow = { span: TimelineSpan; node: TreeNode; color: string | undefined };

export class FlameView implements View {
  readonly viewName = "flame" as const;
  private roots: TreeNode[];
  private drillPath: string[] = [];
  /** undefined = unzoomed: the window tracks the drill root's full extent. */
  private zoom: Interval | undefined;
  private cursor = 0;
  private scrollTop = 0;
  private hideAdmin = true;
  private query: string | undefined;
  private message = "";
  private rows: FlameRow[] = [];

  constructor(
    roots: TreeNode[],
    private readonly traceId: string,
    private readonly thresholds: ViewerThresholds,
    opts: { drillTo?: string } = {},
  ) {
    this.roots = roots;
    if (opts.drillTo !== undefined) {
      this.drillPath = [opts.drillTo];
    }
    this.derive();
  }

  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction {
    const fmt = formatKey(ev);
    const move = (delta: number) => {
      this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    };
    const page = Math.max(1, viewport.rows - 4);
    if (fmt === "Up" || fmt === "k") move(-1);
    else if (fmt === "Down" || fmt === "j") move(1);
    else if (fmt === "g") this.cursor = 0;
    else if (fmt === "G") this.cursor = Math.max(0, this.rows.length - 1);
    else if (fmt === "Ctrl+F" || fmt === "Ctrl+D") move(page);
    else if (fmt === "Ctrl+B" || fmt === "Ctrl+U") move(-page);
    else if (fmt === "Enter" || fmt === "Right" || fmt === "l") return this.drillOrDetail();
    else if (fmt === "Left" || fmt === "h") this.drillOut();
    else if (fmt === "t") return { kind: "open", view: "byName" };
    else if (fmt === "Escape") return { kind: "back" };
    else if (fmt === "o" && this.selected()) {
      return { kind: "focusInTree", spanId: this.selected()!.span.id };
    } else if (fmt === "d" && this.selected()) {
      return { kind: "openDetail", spanId: this.selected()!.span.id };
    } else if (fmt === "a") {
      this.hideAdmin = !this.hideAdmin;
      this.derive();
    } else if (fmt === "+" || fmt === "=") this.zoomBy(0.5);
    else if (fmt === "-") this.zoomBy(2);
    else if (fmt === "[") this.pan(-0.25);
    else if (fmt === "]") this.pan(0.25);
    else if (fmt === "0") this.zoom = undefined;
    else if (fmt === "/") {
      return {
        kind: "promptLine",
        label: "Search: ",
        onResult: (text) => this.applySearch(text),
      };
    } else if (fmt === "n") this.jumpMatch(1);
    else if (fmt === "N") this.jumpMatch(-1);
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const widths = splitWidth("flame", viewport.cols);
    const window = this.window();
    const bodyRows = Math.max(1, viewport.rows - 4);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + bodyRows) this.scrollTop = this.cursor - bodyRows + 1;
    const { element: body } = scrollList<FlameRow>({
      items: this.rows,
      cursorIdx: this.cursor,
      scrollTop: this.scrollTop,
      viewportRows: bodyRows,
      renderItem: (item, isCursor) => this.renderRow(item, isCursor, window, widths),
    });
    return column({ justifyContent: "flex-start" },
      line(this.headerText(window), { fg: "bright-white" }),
      line(new AxisHeader(widths.gutter).computeText(window, this.viewStart(), widths.bar), { fg: "gray" }),
      body,
      line(new SelectionFooter().computeText(this.footerText()), { fg: "bright-white" }),
      line("t view  ↑↓ select  Enter/→ drill  ← out  d detail  o tree  +/- zoom  [ ] pan  0 reset  a admin  / search  Esc back", { fg: "gray" }),
    );
  }

  setData(roots: TreeNode[]): void {
    this.roots = roots;
    this.derive();
  }

  helpLines(): string[] {
    return [
      "t — next view (by-name)",
      "↑↓ / j k, g / G, Ctrl+F/B/D/U — move",
      "Enter / → / l — drill into the selected call (leaf: details)",
      "← / h — drill out",
      "d — full details of the selected call",
      "o — open the selected call in the tree view",
      "+ / - zoom, [ ] pan, 0 reset",
      "a — show/hide administrative spans",
      "/ n N — search row text",
      "y — copy (in details)",
      "Esc — back to the tree",
    ];
  }

  notify(message: string): void {
    this.message = message;
  }

  /** Test probes — reading, never mutating. */
  rowSpans(): TimelineSpan[] {
    return this.rows.map((r) => r.span);
  }
  cursorSpanId(): string | undefined {
    return this.selected()?.span.id;
  }
  currentWindow(): Interval {
    return this.window();
  }

  private derive(): void {
    const trace = this.roots.find((r) => r.traceId === this.traceId) ?? this.roots[0];
    if (trace === undefined) {
      this.rows = [];
      return;
    }
    const cursorId = this.selected()?.span.id;
    this.drillPath = this.drillPath.filter((id) => findNode([trace], id) !== undefined);
    const rootNode = this.drillPath.length > 0
      ? findNode([trace], this.drillPath[this.drillPath.length - 1])!
      : trace;
    const spans = timelineSpans(rootNode, { hideKinds: this.hideAdmin ? ADMIN_KINDS : [] });
    const colorByKey = rankColors(groupSpans(spans, trace));
    const groups = groupSpans(spans, trace);
    const keyBySpanId: Record<string, string> = {};
    for (const g of groups) {
      for (const id of g.spanIds) keyBySpanId[id] = g.key;
    }
    this.rows = spans.map((span) => ({
      span,
      node: findNode([trace], span.id)!,
      color: colorByKey[keyBySpanId[span.id] ?? ""],
    }));
    const restored = this.rows.findIndex((r) => r.span.id === cursorId);
    this.cursor = restored !== -1 ? restored : Math.min(this.cursor, Math.max(0, this.rows.length - 1));
  }

  private selected(): FlameRow | undefined {
    return this.rows[this.cursor];
  }

  private drillOrDetail(): ViewAction {
    const sel = this.selected();
    if (sel === undefined) return { kind: "none" };
    const isCurrentRoot = this.drillPath[this.drillPath.length - 1] === sel.span.id;
    const hasChildren = sel.node.children.some((c) => c.nodeKind === "span");
    if (!isCurrentRoot && hasChildren) {
      this.drillPath = [...this.drillPath, sel.span.id];
      this.zoom = undefined;
      this.cursor = 0;
      this.scrollTop = 0;
      this.derive();
      return { kind: "none" };
    }
    return { kind: "openDetail", spanId: sel.span.id };
  }

  private drillOut(): void {
    if (this.drillPath.length === 0) return;
    this.drillPath = this.drillPath.slice(0, -1);
    this.zoom = undefined;
    this.cursor = 0;
    this.scrollTop = 0;
    this.derive();
  }

  private viewExtent(): Interval {
    if (this.rows.length === 0) return { start: 0, end: 1 };
    return {
      start: Math.min(...this.rows.map((r) => r.span.extent.start)),
      end: Math.max(...this.rows.map((r) => r.span.extent.end)),
    };
  }

  private viewStart(): number {
    return this.viewExtent().start;
  }

  private window(): Interval {
    return this.zoom ?? this.viewExtent();
  }

  private zoomBy(factor: number): void {
    const current = this.window();
    const full = this.viewExtent();
    const sel = this.selected();
    const center = sel !== undefined
      ? (sel.span.extent.start + sel.span.extent.end) / 2
      : (current.start + current.end) / 2;
    const newSpan = Math.min(
      Math.max((current.end - current.start) * factor, 1),
      full.end - full.start,
    );
    let start = center - newSpan / 2;
    let end = center + newSpan / 2;
    if (start < full.start) { end += full.start - start; start = full.start; }
    if (end > full.end) { start -= end - full.end; end = full.end; }
    const clamped = { start: Math.max(start, full.start), end: Math.min(end, full.end) };
    this.zoom = clamped.start === full.start && clamped.end === full.end ? undefined : clamped;
  }

  private pan(fraction: number): void {
    if (this.zoom === undefined) return;
    const full = this.viewExtent();
    const span = this.zoom.end - this.zoom.start;
    let start = this.zoom.start + span * fraction;
    start = Math.max(full.start, Math.min(start, full.end - span));
    this.zoom = { start, end: start + span };
  }

  private applySearch(text: string): void {
    const query = text.trim().toLowerCase();
    this.query = query.length > 0 ? query : undefined;
    if (this.query === undefined) return;
    if (!this.jumpMatch(1, true)) {
      this.message = `no matches for "${text.trim()}"`;
    }
  }

  private jumpMatch(direction: 1 | -1, includeCurrent = false): boolean {
    if (this.query === undefined || this.rows.length === 0) return false;
    const n = this.rows.length;
    for (let step = includeCurrent ? 0 : 1; step <= n; step++) {
      const at = (this.cursor + direction * step + n * (step + 1)) % n;
      if (this.rowText(this.rows[at]).toLowerCase().includes(this.query)) {
        this.cursor = at;
        return true;
      }
    }
    return false;
  }

  private headerText(window: Interval): string {
    const full = this.viewExtent();
    const trace = this.roots.find((r) => r.traceId === this.traceId);
    const crumbs = this.drillPath
      .map((id) => (trace !== undefined ? findNode([trace], id) : undefined))
      .filter((n): n is TreeNode => n !== undefined)
      .map((n) => spanDisplayName(n));
    return new TimelineHeader().computeText({
      view: "flame",
      title: this.traceId.slice(0, 8),
      crumbs,
      totalMs: full.end - full.start,
      zoom: this.zoom !== undefined ? window : undefined,
      viewStart: full.start,
      adminShown: !this.hideAdmin,
    });
  }

  private footerText(): string {
    const sel = this.selected();
    if (sel === undefined) return this.message;
    const base = `${sel.node.summary}  ·  start +${fmtOffset(sel.span.extent.start - this.viewStart())}` +
      `  self ${fmtDuration(sel.span.selfMs, { minutes: true })}`;
    return this.message ? `${base}  ${this.message}` : base;
  }

  private rowText(item: FlameRow): string {
    return new RowLabel(item.node).computeText();
  }

  private renderRow(item: FlameRow, isCursor: boolean, window: Interval, widths: { gutter: number; bar: number; stats: number }): Element {
    const indent = "  ".repeat(Math.min(item.span.depth, 10));
    const label = padCell(clipCell(`${isCursor ? "▶ " : "  "}${indent}${this.rowText(item)}`, widths.gutter - 1), widths.gutter);
    const bar = new BarComponent(
      [item.span.extent],
      { running: item.span.running },
    ).computeCells(window, widths.bar);
    const stats = new DurationCell(this.thresholds).computeText(item.span, widths.stats);
    const identity = isCursor ? "bright-white" : item.color;
    return row(
      line(label + bar, identity !== undefined ? { fg: identity } : undefined),
      line(stats.text, stats.color !== undefined ? { fg: stats.color } : undefined),
    );
  }
}

/** What one flame row SAYS: llm rows show the asked question plus
 *  tokens/cost; tool rows show the tool name and its first string
 *  argument; everything else shows its display name and spanDetail. */
export class RowLabel {
  constructor(private readonly node: TreeNode) {}

  computeText(): string {
    if (this.node.label === "llmCall") {
      const pc = childEvent(this.node, "promptCompletion");
      const asked = pc !== undefined ? lastUserMessage(pc) : undefined;
      const head = asked !== undefined ? `llm · ${truncate(asked.replace(/\s+/g, " "), 60)}` : "llm";
      const cost = this.llmCost();
      return cost !== "" ? `${head} · ${cost}` : head;
    }
    if (this.node.label === "toolExecution") {
      const name = spanDetail(this.node) ?? "tool?";
      const arg = this.firstStringArg();
      return arg !== undefined ? `${name} · ${truncate(arg.replace(/\s+/g, " "), 60)}` : name;
    }
    return spanDisplayName(this.node);
  }

  private llmCost(): string {
    const parts: string[] = [];
    if (this.node.tokens !== undefined) parts.push(`${Math.round(this.node.tokens / 1000)}k tok`);
    if (this.node.cost !== undefined) parts.push(`$${this.node.cost.toFixed(2)}`);
    return parts.join(" ");
  }

  private firstStringArg(): string | undefined {
    const e = childEvent(this.node, "toolCallStart") ?? childEvent(this.node, "toolCall");
    const args = e?.data.args;
    if (args === undefined || args === null || typeof args !== "object") return undefined;
    const first = Object.values(args).find((v) => typeof v === "string");
    return typeof first === "string" ? first : undefined;
  }
}

/** `total`, or `total/self` when they meaningfully differ; colored by the
 *  duration thresholds so "slow" reads the same here as in the tree. */
export class DurationCell {
  constructor(private readonly thresholds: ViewerThresholds) {}

  computeText(span: TimelineSpan, width: number): { text: string; color: string | undefined } {
    const total = span.extent.end - span.extent.start;
    const totalText = fmtDuration(total, { minutes: true });
    const text = span.selfMs < total * 0.95
      ? `${totalText}/${fmtDuration(span.selfMs, { minutes: true })}`
      : totalText;
    return {
      text: text.padStart(width),
      color: durationColor(total, this.thresholds),
    };
  }
}

export function rankColors(groups: { key: string; totalSelfMs: number }[]): Record<string, string | undefined> {
  const ranked = [...groups].sort((a, b) => b.totalSelfMs - a.totalSelfMs);
  const colors: Record<string, string | undefined> = {};
  ranked.forEach((group, i) => {
    colors[group.key] = GROUP_PALETTE[i] ?? "gray";
  });
  return colors;
}

function findNode(roots: TreeNode[], id: string): TreeNode | undefined {
  for (const root of roots) {
    const stack: TreeNode[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      stack.push(...n.children);
    }
  }
  return undefined;
}
