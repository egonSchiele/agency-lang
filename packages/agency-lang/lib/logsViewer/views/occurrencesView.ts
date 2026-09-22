// Every call of one group, chronological, each with the context of where
// it came from. The path shared by every occurrence says nothing, so the
// longest common prefix (cut at a » boundary, never mid-name) lifts into
// the header, leaving each row its distinguishing tail plus the call's
// argument. Membership comes from the kernel's grouping — re-resolved on
// every setData, because a follow-mode re-parse can legitimately re-group
// a call; a vanished key backs out rather than showing stale rows.
import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { scrollList } from "../../tui/scrollList.js";
import { joinPainted, paint, paintedLine, segment } from "../../tui/paint.js";
import { buildTreeIndex, type TreeIndex } from "../forest.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { fmtDuration } from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { groupSpans, spanDisplayName } from "../timeline/groups.js";
import type { Interval } from "../timeline/intervals.js";
import { ADMIN_KINDS, timelineSpans, type TimelineSpan } from "../timeline/spans.js";
import { DurationCell, RowLabel } from "../screens/timelineScreen.js";
import { AxisHeader, BarComponent, SelectionFooter, splitWidth, bottomHints } from "./shared.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

type Occurrence = { span: TimelineSpan; node: TreeNode; contextTail: string; rowNumber: number };

export class OccurrencesView implements View {
  readonly viewName = "occurrences" as const;
  private roots: TreeNode[];
  private cursor = 0;
  private scrollTop = 0;
  private message = "";
  private following = false;
  private stale = false;
  private occ: Occurrence[] = [];
  private sharedPrefix = "";
  private pageRows = 1;
  private moves = {
    by: (delta: number): void => {
      this.cursor = Math.max(0, Math.min(this.occ.length - 1, this.cursor + delta));
    },
    toTop: (): void => {
      this.cursor = 0;
    },
    toBottom: (): void => {
      this.cursor = Math.max(0, this.occ.length - 1);
    },
    page: (): number => this.pageRows,
    halfPage: (): number => Math.max(1, Math.floor(this.pageRows / 2)),
  };

  constructor(
    roots: TreeNode[],
    private readonly traceId: string,
    private readonly groupKey: string,
    private readonly thresholds: ViewerThresholds,
  ) {
    this.roots = roots;
    this.derive();
  }

  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction {
    if (this.stale) {
      return { kind: "back" };
    }
    this.message = ""; // transient, like the tree's message bar
    this.pageRows = Math.max(1, viewport.rows - 4);
    return runViewerKey(this.bindings(), formatKey(ev));
  }

  private bindings(): ViewerBinding[] {
    return [
      ...cursorBindings<ViewAction>(this.moves),
      {
        keys: ["Enter", "Right", "l"],
        help: "open the selected occurrence in the timeline",
        hint: "⏎ timeline",
        run: () => this.openTimeline(),
      },
      {
        keys: ["d"],
        help: "full details of the selected occurrence",
        hint: "d detail",
        run: () => this.openDetail(),
      },
      {
        keys: ["Left", "h", "Escape"],
        help: "return to the overview",
        hint: "← back",
        run: () => ({ kind: "back" }),
      },
    ];
  }

  render(viewport: Viewport): Element {
    const widths = splitWidth("occurrences", viewport.cols);
    const window = this.windowOf();
    const bodyRows = Math.max(1, viewport.rows - 4);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + bodyRows) this.scrollTop = this.cursor - bodyRows + 1;
    const { element: body } = scrollList<Occurrence>({
      items: this.occ,
      cursorIdx: this.cursor,
      scrollTop: this.scrollTop,
      viewportRows: bodyRows,
      renderItem: (item, isCursor) => this.renderRow(item, isCursor, window, widths),
    });
    const under =
      this.sharedPrefix !== "" ? `  (all under ${this.sharedPrefix.replace(/ » $/, "")})` : "";
    return column(
      { justifyContent: "flex-start" },
      paintedLine(
        segment(
          `OCCURRENCES  ${this.groupKey} — ${this.occ.length} call(s)${under}` +
            (this.following ? "  [following]" : "") +
            (this.stale ? "  [group no longer exists — press any key]" : ""),
          viewport.cols,
          { style: { fg: "bright-white" } },
        ),
      ),
      paintedLine(
        segment(
          new AxisHeader(widths.gutter).computeText(window, window.start, widths.bar),
          viewport.cols,
          { style: { fg: "gray" } },
        ),
      ),
      body,
      paintedLine(
        segment(new SelectionFooter().computeText(this.footerText(window)), viewport.cols, {
          style: { fg: "bright-white" },
        }),
      ),
      paintedLine(
        segment(
          bottomHints(hintsFrom(this.bindings()), "occurrences", viewport.cols),
          viewport.cols,
          { style: { fg: "gray" } },
        ),
      ),
    );
  }

  setData(roots: TreeNode[]): void {
    this.roots = roots;
    const keptId = this.occ[this.cursor]?.span.id;
    this.derive();
    if (this.occ.length === 0) {
      this.stale = true;
      this.message = `group ${this.groupKey} no longer exists after reload`;
      return;
    }
    const at = this.occ.findIndex((o) => o.span.id === keptId);
    if (at !== -1) this.cursor = at;
  }

  helpLines(): string[] {
    return helpFrom(this.bindings());
  }

  notify(message: string): void {
    this.message = message;
  }

  setFollowIndicator(on: boolean): void {
    this.following = on;
  }

  /** Test probes. */
  occurrenceIds(): string[] {
    return this.occ.map((o) => o.span.id);
  }
  header(): string {
    return this.sharedPrefix;
  }

  private derive(): void {
    const trace = this.roots.find((r) => r.traceId === this.traceId) ?? this.roots[0];
    if (trace === undefined) {
      this.occ = [];
      return;
    }
    const index = buildTreeIndex(trace);
    const spans = timelineSpans(trace, { hideKinds: ADMIN_KINDS });
    const group = groupSpans(spans, trace, index).find((g) => g.key === this.groupKey);
    if (group === undefined) {
      this.occ = [];
      return;
    }
    const bySpanId: Record<string, TimelineSpan> = Object.create(null);
    for (const s of spans) bySpanId[s.id] = s;
    const members = group.spanIds
      .map((id) => bySpanId[id])
      .filter((s): s is TimelineSpan => s !== undefined)
      .sort((a, b) => a.extent.start - b.extent.start);
    const contexts = members.map((s) => contextPathOf(s.id, index));
    this.sharedPrefix = commonSegmentPrefix(contexts);
    this.occ = members.map((span, i) => ({
      span,
      node: index.byId[span.id],
      contextTail: contexts[i].slice(this.sharedPrefix.length) || "·",
      rowNumber: i + 1,
    }));
  }

  private windowOf(): Interval {
    if (this.occ.length === 0) return { start: 0, end: 1 };
    return {
      start: Math.min(...this.occ.map((o) => o.span.extent.start)),
      end: Math.max(...this.occ.map((o) => o.span.extent.end)),
    };
  }

  private footerText(window: Interval): string {
    const sel = this.occ[this.cursor];
    if (sel === undefined) return this.message;
    const base =
      `${sel.node.summary}  ·  start +${fmtDuration(sel.span.extent.start - window.start, { minutes: true })}` +
      `  self ${fmtDuration(sel.span.selfMs, { minutes: true })}`;
    return this.message ? `${base}  ${this.message}` : base;
  }

  private renderRow(
    item: Occurrence,
    isCursor: boolean,
    window: Interval,
    widths: { gutter: number; bar: number; stats: number },
  ): Element {
    const detail = new RowLabel(item.node).computeText();
    const text = `#${String(item.rowNumber).padStart(2)} ${item.contextTail} · ${detail}`;
    const bar = new BarComponent([item.span.extent], { running: item.span.running }).computeCells(
      window,
      widths.bar,
    );
    const stats = new DurationCell(this.thresholds).computeText(item.span, widths.stats);
    return paintedLine(
      joinPainted(
        segment(`${isCursor ? "▶ " : "  "}${text}`, widths.gutter, {
          style: { fg: isCursor ? "bright-white" : undefined },
        }),
        segment(bar, widths.bar, { style: { fg: isCursor ? "bright-white" : undefined } }),
        segment(stats.text, widths.stats, {
          style: stats.color !== undefined ? { fg: stats.color } : undefined,
        }),
      ),
    );
  }

  private openTimeline(): ViewAction {
    const selected = this.occ[this.cursor];
    return selected === undefined
      ? { kind: "none" }
      : { kind: "openScreen", screen: "timeline", focusId: selected.span.id };
  }

  private openDetail(): ViewAction {
    const selected = this.occ[this.cursor];
    return selected === undefined
      ? { kind: "none" }
      : { kind: "openDetail", rowId: selected.span.id };
  }
}

/** "agentRun » node main » llm » codeAgent" — ancestor display names,
 *  walked up through the tree index (no per-member DFS). */
function contextPathOf(spanId: string, index: TreeIndex): string {
  const names: string[] = [];
  let currentId = index.parentIds[spanId];
  while (currentId !== undefined) {
    const ancestor = index.byId[currentId];
    if (ancestor === undefined) break;
    if (ancestor.nodeKind === "span") {
      names.unshift(ancestor.label === "llmCall" ? "llm" : spanDisplayName(ancestor));
    }
    currentId = index.parentIds[currentId];
  }
  return names.join(" » ");
}

/** Longest common prefix, kept only up to a ` » ` segment boundary: a
 *  string prefix like `codeAgent` shared with `codeAgentHelper` must cut
 *  back to the previous boundary, never mid-name. Fully identical paths
 *  are shared whole. */
function commonSegmentPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0];
  for (const p of paths) {
    while (!p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const segmentComplete = paths.every((p) => p === prefix || p.startsWith(`${prefix} » `));
  if (segmentComplete) {
    return paths.some((p) => p !== prefix) ? `${prefix} » ` : prefix;
  }
  const at = prefix.lastIndexOf(" » ");
  return at === -1 ? "" : prefix.slice(0, at + 3);
}
