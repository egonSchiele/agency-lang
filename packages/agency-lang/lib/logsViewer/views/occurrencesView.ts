// Every call of one group, chronological, each with the context of where
// it came from. The path shared by every occurrence says nothing, so the
// longest common prefix (cut at a » boundary, never mid-name) lifts into
// the header, leaving each row its distinguishing tail plus the call's
// argument. Membership comes from the kernel's grouping — re-resolved on
// every setData, because a follow-mode re-parse can legitimately re-group
// a call; a vanished key backs out rather than showing stale rows.
import { column, line, row } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { scrollList } from "../../tui/scrollList.js";
import { fmtDuration } from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { groupSpans, spanDisplayName } from "../timeline/groups.js";
import type { Interval } from "../timeline/intervals.js";
import { ADMIN_KINDS, timelineSpans, type TimelineSpan } from "../timeline/spans.js";
import { DurationCell, RowLabel } from "./flameView.js";
import {
  AxisHeader,
  BarComponent,
  SelectionFooter,
  clipCell,
  padCell,
  splitWidth,
} from "./shared.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

type Occurrence = { span: TimelineSpan; node: TreeNode; contextTail: string };

export class OccurrencesView implements View {
  readonly viewName = "occurrences" as const;
  private roots: TreeNode[];
  private cursor = 0;
  private scrollTop = 0;
  private message = "";
  private stale = false;
  private occ: Occurrence[] = [];
  private sharedPrefix = "";

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
    const fmt = formatKey(ev);
    const move = (delta: number) => {
      this.cursor = Math.max(0, Math.min(this.occ.length - 1, this.cursor + delta));
    };
    const page = Math.max(1, viewport.rows - 4);
    if (fmt === "Up" || fmt === "k") move(-1);
    else if (fmt === "Down" || fmt === "j") move(1);
    else if (fmt === "g") this.cursor = 0;
    else if (fmt === "G") this.cursor = Math.max(0, this.occ.length - 1);
    else if (fmt === "Ctrl+F" || fmt === "Ctrl+D") move(page);
    else if (fmt === "Ctrl+B" || fmt === "Ctrl+U") move(-page);
    else if (fmt === "Enter" || fmt === "Right" || fmt === "l") {
      const sel = this.occ[this.cursor];
      if (sel === undefined) return { kind: "none" };
      const hasChildren = sel.node.children.some((c) => c.nodeKind === "span");
      return hasChildren
        ? { kind: "openFlameAt", spanId: sel.span.id }
        : { kind: "openDetail", spanId: sel.span.id };
    } else if (fmt === "Left" || fmt === "h" || fmt === "Escape") return { kind: "back" };
    else if (fmt === "t") return { kind: "back" };
    else if (fmt === "d") {
      const sel = this.occ[this.cursor];
      if (sel !== undefined) return { kind: "openDetail", spanId: sel.span.id };
    } else if (fmt === "o") {
      const sel = this.occ[this.cursor];
      if (sel !== undefined) return { kind: "focusInTree", spanId: sel.span.id };
    }
    return { kind: "none" };
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
    const under = this.sharedPrefix !== ""
      ? `  (all under ${this.sharedPrefix.replace(/ » $/, "")})`
      : "";
    return column({ justifyContent: "flex-start" },
      line(`TIMELINE [occurrences]  ${this.groupKey} — ${this.occ.length} call(s)${under}` +
        (this.stale ? "  [group no longer exists — press any key]" : ""), { fg: "bright-white" }),
      line(new AxisHeader(widths.gutter).computeText(window, window.start, widths.bar), { fg: "gray" }),
      body,
      line(new SelectionFooter().computeText(this.footerText(window)), { fg: "bright-white" }),
      line("↑↓ select  Enter/→ drill or detail  d detail  o tree  ←/Esc back to by-name", { fg: "gray" }),
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
    return [
      "↑↓ / j k, g / G, Ctrl+F/B/D/U — move",
      "Enter / → — drill into the call (leaf: details)",
      "d — details   o — open in tree",
      "← / Esc — back to by-name",
    ];
  }

  notify(message: string): void {
    this.message = message;
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
    const spans = timelineSpans(trace, { hideKinds: ADMIN_KINDS });
    const group = groupSpans(spans, trace).find((g) => g.key === this.groupKey);
    if (group === undefined) {
      this.occ = [];
      return;
    }
    const bySpanId: Record<string, TimelineSpan> = {};
    for (const s of spans) bySpanId[s.id] = s;
    const members = group.spanIds
      .map((id) => bySpanId[id])
      .filter((s): s is TimelineSpan => s !== undefined)
      .sort((a, b) => a.extent.start - b.extent.start);
    const contexts = members.map((s) => contextPathOf(s.id, trace));
    this.sharedPrefix = commonSegmentPrefix(contexts);
    this.occ = members.map((span, i) => ({
      span,
      node: findNode(trace, span.id)!,
      contextTail: contexts[i].slice(this.sharedPrefix.length) || "·",
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
    const base = `${sel.node.summary}  ·  start +${fmtDuration(sel.span.extent.start - window.start, { minutes: true })}` +
      `  self ${fmtDuration(sel.span.selfMs, { minutes: true })}`;
    return this.message ? `${base}  ${this.message}` : base;
  }

  private renderRow(item: Occurrence, isCursor: boolean, window: Interval, widths: { gutter: number; bar: number; stats: number }): Element {
    const index = this.occ.indexOf(item) + 1;
    const detail = new RowLabel(item.node).computeText();
    const text = `#${String(index).padStart(2)} ${item.contextTail} · ${detail}`;
    const label = padCell(clipCell(`${isCursor ? "▶ " : "  "}${text}`, widths.gutter - 1), widths.gutter);
    const bar = new BarComponent([item.span.extent], { running: item.span.running })
      .computeCells(window, widths.bar);
    const stats = new DurationCell(this.thresholds).computeText(item.span, widths.stats);
    return row(
      line(label + bar, { fg: isCursor ? "bright-white" : undefined }),
      line(stats.text, stats.color !== undefined ? { fg: stats.color } : undefined),
    );
  }
}

/** "agentRun » node main » llm » codeAgent" — ancestor display names. */
function contextPathOf(spanId: string, trace: TreeNode): string {
  const path: TreeNode[] = [];
  const find = (n: TreeNode, trail: TreeNode[]): boolean => {
    if (n.id === spanId) {
      path.push(...trail);
      return true;
    }
    return n.children.some((c) => find(c, [...trail, n]));
  };
  find(trace, []);
  return path
    .filter((n) => n.nodeKind === "span")
    .map((n) => (n.label === "llmCall" ? "llm" : spanDisplayName(n)))
    .join(" » ");
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
  const segmentComplete = paths.every(
    (p) => p === prefix || p.startsWith(`${prefix} » `),
  );
  if (segmentComplete) {
    return paths.some((p) => p !== prefix) ? `${prefix} » ` : prefix;
  }
  const at = prefix.lastIndexOf(" » ");
  return at === -1 ? "" : prefix.slice(0, at + 3);
}

function findNode(trace: TreeNode, id: string): TreeNode | undefined {
  const stack: TreeNode[] = [trace];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return undefined;
}
