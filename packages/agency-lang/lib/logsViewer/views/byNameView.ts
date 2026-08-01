// The by-name view: one row per GROUP (thread label → enclosing function
// → model for llm calls; plain names for everything else), every call
// drawn as self-interval bars on one axis, with count / total self-time /
// share at the right. Groups come from the kernel — never computed here —
// so this view and occurrences can never disagree about membership.
import { column, line, row } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { scrollList } from "../../tui/scrollList.js";
import { fmtDuration } from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { groupSpans, type SpanGroup } from "../timeline/groups.js";
import type { Interval } from "../timeline/intervals.js";
import { ADMIN_KINDS, timelineSpans, type TimelineSpan } from "../timeline/spans.js";
import { rankColors } from "./flameView.js";
import {
  AxisHeader,
  BarComponent,
  SelectionFooter,
  TimelineHeader,
  clipCell,
  padCell,
  splitWidth,
} from "./shared.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

type GroupRow = { group: SpanGroup; spans: TimelineSpan[]; color: string | undefined };

export class ByNameView implements View {
  readonly viewName = "byName" as const;
  private roots: TreeNode[];
  private zoom: Interval | undefined;
  private cursor = 0;
  private scrollTop = 0;
  private hideAdmin = true;
  private query: string | undefined;
  private message = "";
  private rows: GroupRow[] = [];

  constructor(
    roots: TreeNode[],
    private readonly traceId: string,
    private readonly thresholds: ViewerThresholds,
  ) {
    this.roots = roots;
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
    else if (fmt === "Enter" || fmt === "Right" || fmt === "l") {
      const sel = this.selected();
      if (sel !== undefined) return { kind: "openOccurrences", groupKey: sel.group.key };
    } else if (fmt === "t" || fmt === "Escape") return { kind: "open", view: "tree" };
    else if (fmt === "d") {
      const longest = this.longestOf(this.selected());
      if (longest !== undefined) return { kind: "openDetail", spanId: longest.id };
    } else if (fmt === "o") {
      const longest = this.longestOf(this.selected());
      if (longest !== undefined) return { kind: "focusInTree", spanId: longest.id };
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
    const widths = splitWidth("byName", viewport.cols);
    const window = this.window();
    const bodyRows = Math.max(1, viewport.rows - 4);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + bodyRows) this.scrollTop = this.cursor - bodyRows + 1;
    const { element: body } = scrollList<GroupRow>({
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
      line("t/Esc back to tree  ↑↓ select  Enter occurrences  d detail  o tree  +/- zoom  [ ] pan  0 reset  a admin  / search", { fg: "gray" }),
    );
  }

  setData(roots: TreeNode[]): void {
    this.roots = roots;
    const keptKey = this.selected()?.group.key;
    this.derive();
    if (keptKey !== undefined) {
      const at = this.rows.findIndex((r) => r.group.key === keptKey);
      if (at !== -1) this.cursor = at;
    }
  }

  helpLines(): string[] {
    return [
      "t / Esc — back to the tree",
      "↑↓ / j k, g / G, Ctrl+F/B/D/U — move",
      "Enter / → — every call of this group (occurrences)",
      "d — details of the group's longest call",
      "o — open the longest call in the tree",
      "+ / - zoom, [ ] pan, 0 reset",
      "a — show/hide administrative spans",
      "/ n N — search rows",
    ];
  }

  notify(message: string): void {
    this.message = message;
  }

  /** Test probes. */
  groupRows(): SpanGroup[] {
    return this.rows.map((r) => r.group);
  }
  cursorGroupKey(): string | undefined {
    return this.selected()?.group.key;
  }

  private derive(): void {
    const trace = this.trace();
    if (trace === undefined) {
      this.rows = [];
      return;
    }
    const spans = timelineSpans(trace, { hideKinds: this.hideAdmin ? ADMIN_KINDS : [] });
    const bySpanId: Record<string, TimelineSpan> = {};
    for (const s of spans) bySpanId[s.id] = s;
    const groups = groupSpans(spans, trace);
    const colors = rankColors(groups);
    this.rows = groups.map((group) => ({
      group,
      spans: group.spanIds.map((id) => bySpanId[id]).filter((s) => s !== undefined),
      color: colors[group.key],
    }));
    this.cursor = Math.min(this.cursor, Math.max(0, this.rows.length - 1));
  }

  private trace(): TreeNode | undefined {
    return this.roots.find((r) => r.traceId === this.traceId) ?? this.roots[0];
  }

  private selected(): GroupRow | undefined {
    return this.rows[this.cursor];
  }

  private longestOf(rowItem: GroupRow | undefined): TimelineSpan | undefined {
    if (rowItem === undefined || rowItem.spans.length === 0) return undefined;
    return [...rowItem.spans]
      .sort((a, b) => (b.extent.end - b.extent.start) - (a.extent.end - a.extent.start))[0];
  }

  private viewExtent(): Interval {
    if (this.rows.length === 0) return { start: 0, end: 1 };
    const all = this.rows.flatMap((r) => r.spans);
    return {
      start: Math.min(...all.map((s) => s.extent.start)),
      end: Math.max(...all.map((s) => s.extent.end)),
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
    const center = (current.start + current.end) / 2;
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
      if (this.rows[at].group.key.toLowerCase().includes(this.query)) {
        this.cursor = at;
        return true;
      }
    }
    return false;
  }

  private headerText(window: Interval): string {
    const full = this.viewExtent();
    return new TimelineHeader().computeText({
      view: "byName",
      title: this.traceId.slice(0, 8),
      crumbs: [],
      totalMs: full.end - full.start,
      zoom: this.zoom !== undefined ? window : undefined,
      viewStart: full.start,
      adminShown: !this.hideAdmin,
    });
  }

  private footerText(): string {
    const sel = this.selected();
    if (sel === undefined) return this.message;
    const models = sel.group.models.length > 0 ? `  models: ${sel.group.models.join(", ")}` : "";
    const base = `${sel.group.key}  ${sel.group.count} call(s)` +
      `  self-time total ${fmtDuration(sel.group.totalSelfMs, { minutes: true })}` +
      `  ${Math.round(sel.group.share * 100)}% of view${models}`;
    return this.message ? `${base}  ${this.message}` : base;
  }

  private renderRow(item: GroupRow, isCursor: boolean, window: Interval, widths: { gutter: number; bar: number; stats: number }): Element {
    const label = padCell(clipCell(`${isCursor ? "▶ " : "  "}${item.group.key}`, widths.gutter - 1), widths.gutter);
    const bar = new BarComponent(
      item.spans.flatMap((s) => s.selfIntervals),
      { running: item.spans.some((s) => s.running) },
    ).computeCells(window, widths.bar);
    const stats = new GroupStatsCell().computeText(item.group, widths.stats);
    const identity = isCursor ? "bright-white" : item.color;
    return row(
      line(label + bar, identity !== undefined ? { fg: identity } : undefined),
      line(stats),
    );
  }
}

/** `  62×   41.2s  3%` — count, total self-time, share. Share can exceed
 *  100% for parallel work; that is real compute time (spec v2.1). */
export class GroupStatsCell {
  computeText(group: SpanGroup, width: number): string {
    const text = `${group.count}× ${fmtDuration(group.totalSelfMs, { minutes: true })} ${Math.round(group.share * 100)}%`;
    return text.padStart(width);
  }
}
