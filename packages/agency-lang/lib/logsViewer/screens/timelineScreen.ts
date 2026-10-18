import { paint, paintedLine, segment, joinPainted, type Painted } from "../../tui/paint.js";
import { THEME, durationTone, toneStyle, hotMark } from "../theme.js";
import { fmtTokens, fmtUsd } from "../format.js";
import { roundsOf, parseRoundId, type Round } from "../timeline/rounds.js";
import { timelineRows, rowIdFor, type TimelineRow } from "../timeline/rows.js";
import { ancestorsOf } from "../forest.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import type { Screen } from "./screen.js";
import { keyFooter } from "./chrome.js";
import { lineNumber, lineNumberWidth } from "./lineNumbers.js";
import type { WidthSplit } from "../views/shared.js";
const ZOOM_IN = 0.5;
const ZOOM_OUT = 2;
const PAN_STEP = 0.25;
const CHROME_ROWS = 4;
const LAYOUT = { indentCells: 2, maxIndentLevels: 10, cursorMarker: "▶ ", noMarker: "  " };
// Timeline rows share a time axis and can be drilled into nested calls.
import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { scrollList } from "../../tui/scrollList.js";
import { buildTreeIndex, nearestAncestor, type TreeIndex } from "../forest.js";
import { llmGroupTitle, storyOutline } from "../story.js";
import { decisionSummary } from "../decision.js";
import {
  childEvent,
  durationColor,
  fmtDuration,
  lastUserMessage,
  spanDetail,
  toolArgSummary,
  truncate,
} from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { spanDisplayName } from "../timeline/groups.js";
import type { Interval } from "../timeline/intervals.js";
import { ADMIN_KINDS, timelineSpans, type TimelineSpan } from "../timeline/spans.js";
import {
  AxisHeader,
  BarComponent,
  SelectionFooter,
  TimelineHeader,
  fmtOffset,
  splitWidth,
} from "../views/shared.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";

type FlameRow = { row: TimelineRow; node: TreeNode; color: string };

export class TimelineScreen implements Screen {
  readonly screenName = "timeline" as const;
  private rounds: Round[] = [];
  /** Tool spans the story outline says are waiting for an interrupt response. */
  private waitingToolIds: string[] = [];
  private pageRows = 1;
  private moves = {
    by: (delta: number): void => {
      this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    },
    toTop: (): void => {
      this.cursor = 0;
    },
    toBottom: (): void => {
      this.cursor = Math.max(0, this.rows.length - 1);
    },
    page: (): number => this.pageRows,
    halfPage: (): number => Math.max(1, Math.floor(this.pageRows / 2)),
  };
  private roots: TreeNode[];
  private drillPath: string[] = [];
  /** undefined = unzoomed: the window tracks the drill root's full extent. */
  private zoom: Interval | undefined;
  private cursor = 0;
  private scrollTop = 0;
  private hideAdmin = true;
  private query: string | undefined;
  private message = "";
  private following = false;
  private lineNumbers = false;
  private index: TreeIndex | undefined;
  /** Every row of the drill view, folded ones included. */
  private allRows: FlameRow[] = [];
  /** The rows drawn: `allRows` without what sits under a folded span. */
  private rows: FlameRow[] = [];
  /** Spans the reader folded. */
  private folded: string[] = [];
  /** Completed sub-agent groups folded on first sight, as on the trace. */
  private defaultFolded: string[] = [];
  /** Groups whose default has been applied once, so a group the reader
   *  opened stays open across follow updates. */
  private foldDefaultsApplied: string[] = [];

  constructor(
    roots: TreeNode[],
    private traceId: string,
    private readonly thresholds: ViewerThresholds,
    opts: { drillTo?: string } = {},
  ) {
    this.roots = roots;
    if (opts.drillTo !== undefined) {
      this.drillPath = [opts.drillTo];
    }
    this.derive();
  }

  private bindings(): ViewerBinding[] {
    const zoomed = (): boolean => this.zoom !== undefined;
    return [
      ...cursorBindings<ViewAction>(this.moves),
      {
        keys: ["["],
        help: "previous sibling, skipping descendants",
        hint: "[ ] sibling",
        run: () => this.moveSibling(-1),
      },
      {
        keys: ["]"],
        help: "next sibling, skipping descendants",
        run: () => this.moveSibling(1),
      },
      {
        keys: ["#"],
        help: "toggle line numbers",
        hint: "# numbers",
        run: () => {
          this.lineNumbers = !this.lineNumbers;
        },
      },
      {
        keys: ["Enter"],
        help: "fold or unfold the selected span; on an LLM call, open it in the trace",
        hint: "⏎ fold",
        run: () => this.toggleFoldOrOpen(),
      },
      {
        keys: ["Right", "l"],
        help: "drill into the selected span; on an LLM call, open it in the trace",
        hint: "→ drill",
        run: () => this.drillOrOpen(),
      },
      {
        keys: ["Left", "h"],
        help: "drill out",
        hint: "← out",
        when: () => this.drillPath.length > 0,
        run: () => this.drillOut(),
      },
      {
        keys: ["d"],
        help: "full details of the selected row",
        hint: "d detail",
        run: () => this.openDetail(),
      },
      { keys: ["+", "="], help: "zoom in", hint: "+/- zoom", run: () => this.zoomBy(ZOOM_IN) },
      { keys: ["-"], help: "zoom out", run: () => this.zoomBy(ZOOM_OUT) },
      {
        keys: ["{"],
        help: "pan left",
        hint: "{ } pan",
        when: zoomed,
        run: () => this.pan(-PAN_STEP),
      },
      { keys: ["}"], help: "pan right", when: zoomed, run: () => this.pan(PAN_STEP) },
      {
        keys: ["0"],
        help: "reset the zoom",
        hint: "0 reset",
        when: zoomed,
        run: () => this.resetZoom(),
      },
      {
        keys: ["a"],
        help: "show or hide administrative spans",
        hint: "a admin",
        run: () => this.toggleAdmin(),
      },
      { keys: ["/"], help: "search row text", hint: "/ search", run: () => this.promptSearch() },
      {
        keys: ["n"],
        help: "next match",
        when: () => this.query !== undefined,
        run: () => this.jumpMatch(1),
      },
      {
        keys: ["N"],
        help: "previous match",
        when: () => this.query !== undefined,
        run: () => this.jumpMatch(-1),
      },
    ];
  }

  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction {
    this.message = "";
    this.pageRows = Math.max(1, viewport.rows - CHROME_ROWS);
    return runViewerKey(this.bindings(), formatKey(ev));
  }

  helpLines(): string[] {
    return helpFrom(this.bindings());
  }

  private moveSibling(direction: -1 | 1): void {
    const selected = this.selected();
    if (selected === undefined) return;
    for (
      let position = this.cursor + direction;
      position >= 0 && position < this.rows.length;
      position += direction
    ) {
      const { row } = this.rows[position];
      if (row.depth < selected.row.depth) return;
      if (row.depth === selected.row.depth) {
        this.cursor = position;
        return;
      }
    }
  }

  private openDetail(): ViewAction {
    const selected = this.selected();
    return selected === undefined
      ? { kind: "none" }
      : { kind: "openDetail", rowId: selected.row.id };
  }
  private resetZoom(): void {
    this.zoom = undefined;
  }
  private toggleAdmin(): void {
    this.hideAdmin = !this.hideAdmin;
    this.derive();
  }
  private promptSearch(): ViewAction {
    return { kind: "promptLine", label: "Search: ", onResult: (text) => this.applySearch(text) };
  }
  render(viewport: Viewport, sharedHints = ""): Element {
    const numberWidth = this.lineNumbers ? lineNumberWidth(this.rows.length) : 0;
    const widths = splitWidth("timeline", viewport.cols - numberWidth);
    const window = this.window();
    const bodyRows = Math.max(1, viewport.rows - CHROME_ROWS);
    if (this.cursor < this.scrollTop) {
      this.scrollTop = this.cursor;
    }
    if (this.cursor >= this.scrollTop + bodyRows) {
      this.scrollTop = this.cursor - bodyRows + 1;
    }
    const { element: body } = scrollList<FlameRow>({
      items: this.rows,
      cursorIdx: this.cursor,
      scrollTop: this.scrollTop,
      viewportRows: bodyRows,
      renderItem: (item, isCursor) => this.renderRow(item, isCursor, window, widths),
    });
    return column(
      { justifyContent: "flex-start" },
      paintedLine(paint(this.headerText(window), { fg: THEME.text })),
      paintedLine(
        paint(
          new AxisHeader(widths.gutter + numberWidth).computeText(
            window,
            this.viewStart(),
            widths.bar,
          ),
          {
            fg: THEME.chrome,
          },
        ),
      ),
      body,
      paintedLine(paint(new SelectionFooter().computeText(this.footerText()), { fg: THEME.text })),
      keyFooter(hintsFrom(this.bindings()), viewport.cols, "TIMELINE", sharedHints),
    );
  }

  setData(roots: TreeNode[]): void {
    this.roots = roots;
    this.derive();
  }

  focusId(): string | undefined {
    return this.selected()?.row.id;
  }

  setFocus(id: string): void {
    const target = this.drawnIdFor(id) ?? this.afterLeavingDrill(id);
    if (target !== undefined) {
      this.reveal(target);
    }
  }

  setTrace(traceId: string): void {
    this.traceId = traceId;
    this.folded = [];
    this.defaultFolded = [];
    this.foldDefaultsApplied = [];
    this.drillPath = [];
    this.zoom = undefined;
    this.cursor = 0;
    this.scrollTop = 0;
    this.derive();
  }

  applySearch(query: string): void {
    this.applySearchText(query);
  }

  escape(): boolean {
    if (this.query !== undefined) {
      this.query = undefined;
      return true;
    }
    if (this.drillPath.length > 0) {
      this.drillOut();
      return true;
    }
    return false;
  }

  /** The row `id` lands on in the current view: itself, a lone round's
   *  span, or the nearest ancestor that is drawn. A row under a folded
   *  span counts as drawn; `reveal` opens the way to it. */
  private drawnIdFor(id: string): string | undefined {
    const timelineRowsNow = this.allRows.map((item) => item.row);
    const direct = rowIdFor(id, timelineRowsNow, this.rounds);
    if (direct !== undefined) {
      return direct;
    }
    const node = this.index?.byId[parseRoundId(id)?.spanId ?? id];
    if (node === undefined || this.index === undefined) {
      return undefined;
    }
    const drawn = ancestorsOf(node, this.index).find((ancestor) =>
      timelineRowsNow.some((row) => row.id === ancestor.id),
    );
    return drawn?.id;
  }

  /** A focus outside the drilled-in subtree: leave the drill so it shows. */
  private afterLeavingDrill(id: string): string | undefined {
    if (this.drillPath.length === 0) {
      return undefined;
    }
    const drillPath = this.drillPath;
    const cursor = this.cursor;
    const rows = this.rows;
    this.drillPath = [];
    this.derive();
    const target = this.drawnIdFor(id);
    if (target === undefined) {
      this.drillPath = drillPath;
      this.rows = rows;
      this.cursor = cursor;
    }
    return target;
  }

  notify(message: string): void {
    this.message = message;
  }

  setFollowIndicator(on: boolean): void {
    this.following = on;
  }

  /** Test probes — reading, never mutating. */
  rowSpans(): TimelineSpan[] {
    return this.rows.flatMap((item) => (item.row.kind === "span" ? [item.row.span] : []));
  }
  cursorSpanId(): string | undefined {
    return this.selected()?.row.id;
  }
  currentWindow(): Interval {
    return this.window();
  }

  private derive(): void {
    const trace = this.roots.find((root) => root.traceId === this.traceId) ?? this.roots[0];
    if (trace === undefined) {
      this.rows = [];
      return;
    }
    const selected = this.selected();
    const previousAncestors =
      selected === undefined || this.index === undefined
        ? []
        : ancestorsOf(selected.node, this.index);
    const focusCandidates =
      selected === undefined ? [] : [selected.row.id, ...previousAncestors.map((node) => node.id)];
    const index = buildTreeIndex(trace);
    this.index = index;
    this.drillPath = this.drillPath.filter((id) => index.byId[id] !== undefined);
    const rootNode =
      this.drillPath.length > 0 ? index.byId[this.drillPath[this.drillPath.length - 1]] : trace;
    const spans = timelineSpans(rootNode, { hideKinds: this.hideAdmin ? ADMIN_KINDS : [] });
    this.rounds = roundsOf(trace, index);
    this.waitingToolIds = storyOutline(trace, { admin: false }).flatMap((row) =>
      row.kind === "tool" && row.status === "awaitingApproval" ? [row.id] : [],
    );
    this.allRows = timelineRows(
      spans,
      this.rounds,
      rootNode.nodeKind === "trace" ? rootNode.id : undefined,
    ).map((row) => ({
      row,
      node: row.kind === "round" ? row.round.node : index.byId[row.id],
      color: row.kind === "round" ? THEME.kind.assistant : spanColor(index.byId[row.id]),
    }));
    this.applyFoldDefaults(index);
    this.rows = this.visibleRows();
    const target = focusCandidates.map((id) => this.drawnIdFor(id)).find((id) => id !== undefined);
    this.cursor = target === undefined ? 0 : this.nearestVisible(target);
  }

  /** A completed `llmCall` span inside a tool folds the first time it is
   *  seen, as a sub-agent's group does on the trace; a top-level thread
   *  never folds by itself. A fold reopens when its span runs again. */
  private applyFoldDefaults(index: TreeIndex): void {
    this.defaultFolded = this.defaultFolded.filter((id) => {
      const item = this.allRows.find((candidate) => candidate.row.id === id);
      return item === undefined || !isRunning(item.row);
    });
    for (const [position, item] of this.allRows.entries()) {
      const insideTool =
        nearestAncestor(item.node, index, (node) => node.label === "toolExecution") !== undefined;
      if (
        item.row.kind !== "span" ||
        item.node.label !== "llmCall" ||
        !insideTool ||
        isRunning(item.row) ||
        !this.hasChildRows(position) ||
        this.foldDefaultsApplied.includes(item.row.id)
      ) {
        continue;
      }
      this.defaultFolded.push(item.row.id);
      this.foldDefaultsApplied.push(item.row.id);
    }
  }
  private hasChildRows(position: number): boolean {
    const next = this.allRows[position + 1];
    return next !== undefined && next.row.depth > this.allRows[position].row.depth;
  }
  private isFolded(id: string): boolean {
    return this.folded.includes(id) || this.defaultFolded.includes(id);
  }
  /** `allRows` without the rows under a folded span: once a folded row is
   *  met, everything deeper than it is skipped until a row at its depth
   *  or above. */
  private visibleRows(): FlameRow[] {
    const shown: FlameRow[] = [];
    let hiddenBelow: number | undefined;
    for (const item of this.allRows) {
      if (hiddenBelow !== undefined && item.row.depth > hiddenBelow) {
        continue;
      }
      hiddenBelow = this.isFolded(item.row.id) ? item.row.depth : undefined;
      shown.push(item);
    }
    return shown;
  }
  /** The rows above `position` in `allRows` that contain it: the nearest
   *  shallower row, then the nearest shallower than that, and so on. */
  private ancestorRows(position: number): FlameRow[] {
    const ancestors: FlameRow[] = [];
    let depth = this.allRows[position].row.depth;
    for (let at = position - 1; at >= 0; at -= 1) {
      if (this.allRows[at].row.depth < depth) {
        ancestors.push(this.allRows[at]);
        depth = this.allRows[at].row.depth;
      }
    }
    return ancestors;
  }
  private open(ids: string[]): void {
    this.folded = this.folded.filter((id) => !ids.includes(id));
    this.defaultFolded = this.defaultFolded.filter((id) => !ids.includes(id));
    for (const id of ids) {
      if (!this.foldDefaultsApplied.includes(id)) {
        this.foldDefaultsApplied.push(id);
      }
    }
  }
  /** Open every fold above the row and put the cursor on it. */
  private reveal(id: string): void {
    const position = this.allRows.findIndex((item) => item.row.id === id);
    if (position === -1) {
      return;
    }
    this.open(this.ancestorRows(position).map((item) => item.row.id));
    this.rows = this.visibleRows();
    this.cursor = this.rows.findIndex((item) => item.row.id === id);
  }
  /** The visible position of `id`, or of the folded span that hides it. */
  private nearestVisible(id: string): number {
    const direct = this.rows.findIndex((item) => item.row.id === id);
    if (direct !== -1) {
      return direct;
    }
    const position = this.allRows.findIndex((item) => item.row.id === id);
    if (position === -1) {
      return 0;
    }
    const holder = this.ancestorRows(position).find((item) =>
      this.rows.some((shown) => shown === item),
    );
    return Math.max(0, holder === undefined ? 0 : this.rows.indexOf(holder));
  }
  /** Enter: fold or unfold a span with rows under it. A round opens in the
   *  trace and a span with nothing under it opens its detail, as Right does. */
  private toggleFoldOrOpen(): ViewAction {
    const sel = this.selected();
    if (sel === undefined) {
      return { kind: "none" };
    }
    const position = this.allRows.indexOf(sel);
    if (sel.row.kind === "round" || !this.hasChildRows(position)) {
      return this.drillOrOpen();
    }
    if (this.isFolded(sel.row.id)) {
      this.open([sel.row.id]);
    } else {
      this.folded.push(sel.row.id);
    }
    this.rows = this.visibleRows();
    this.cursor = this.rows.indexOf(sel);
    return { kind: "none" };
  }

  private selected(): FlameRow | undefined {
    return this.rows[this.cursor];
  }

  private drillOrOpen(): ViewAction {
    const sel = this.selected();
    if (sel === undefined) {
      return { kind: "none" };
    }
    if (sel.row.kind === "round") {
      return { kind: "openScreen", screen: "trace", focusId: sel.row.id };
    }
    const isCurrentRoot = this.drillPath[this.drillPath.length - 1] === sel.row.id;
    const hasChildren =
      sel.node.children.some((child) => child.nodeKind === "span") ||
      this.rounds.filter((round) => round.spanId === sel.row.id).length > 1;
    if (!isCurrentRoot && hasChildren) {
      this.drillPath = [...this.drillPath, sel.row.id];
      this.zoom = undefined;
      this.cursor = 0;
      this.scrollTop = 0;
      this.derive();
      return { kind: "none" };
    }
    return { kind: "openDetail", rowId: sel.row.id };
  }

  private drillOut(): void {
    if (this.drillPath.length === 0) {
      return;
    }
    this.drillPath = this.drillPath.slice(0, -1);
    this.zoom = undefined;
    this.cursor = 0;
    this.scrollTop = 0;
    this.derive();
  }

  private viewExtent(): Interval {
    if (this.rows.length === 0) {
      return { start: 0, end: 1 };
    }
    return {
      start: Math.min(...this.rows.map((item) => extentOf(item.row).start)),
      end: Math.max(...this.rows.map((item) => extentOf(item.row).end)),
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
    const center =
      sel !== undefined
        ? (extentOf(sel.row).start + extentOf(sel.row).end) / 2
        : (current.start + current.end) / 2;
    const newSpan = Math.min(
      Math.max((current.end - current.start) * factor, 1),
      full.end - full.start,
    );
    let start = center - newSpan / 2;
    let end = center + newSpan / 2;
    if (start < full.start) {
      end += full.start - start;
      start = full.start;
    }
    if (end > full.end) {
      start -= end - full.end;
      end = full.end;
    }
    const clamped = { start: Math.max(start, full.start), end: Math.min(end, full.end) };
    this.zoom = clamped.start === full.start && clamped.end === full.end ? undefined : clamped;
  }

  private pan(fraction: number): void {
    if (this.zoom === undefined) {
      return;
    }
    const full = this.viewExtent();
    const span = this.zoom.end - this.zoom.start;
    let start = this.zoom.start + span * fraction;
    start = Math.max(full.start, Math.min(start, full.end - span));
    this.zoom = { start, end: start + span };
  }

  private applySearchText(text: string): void {
    const query = text.trim().toLowerCase();
    this.query = query.length > 0 ? query : undefined;
    if (this.query === undefined) {
      return;
    }
    if (!this.jumpMatch(1, true)) {
      this.message = `no matches for "${text.trim()}"`;
    }
  }

  /** Searches every row, folded or not, and opens the way to a match. */
  private jumpMatch(direction: 1 | -1, includeCurrent = false): boolean {
    if (this.query === undefined || this.allRows.length === 0) {
      return false;
    }
    const count = this.allRows.length;
    const from = Math.max(0, this.allRows.indexOf(this.selected()!));
    for (let step = includeCurrent ? 0 : 1; step <= count; step++) {
      const at = (from + direction * step + count * (step + 1)) % count;
      if (this.rowText(this.allRows[at]).toLowerCase().includes(this.query)) {
        this.reveal(this.allRows[at].row.id);
        return true;
      }
    }
    return false;
  }

  private headerText(window: Interval): string {
    const full = this.viewExtent();
    const crumbs = this.drillPath
      .map((id) => this.index?.byId[id])
      .filter((node): node is TreeNode => node !== undefined)
      .map((node) => this.threadLabel(node) ?? spanDisplayName(node));
    return new TimelineHeader().computeText({
      crumbs,
      totalMs: full.end - full.start,
      zoom: this.zoom !== undefined ? window : undefined,
      viewStart: full.start,
      adminShown: !this.hideAdmin,
      following: this.following,
    });
  }

  private footerText(): string {
    const sel = this.selected();
    if (sel === undefined) {
      return this.message;
    }
    const label =
      (sel.row.kind === "span" ? this.threadLabel(sel.node) : undefined) ?? sel.node.summary;
    const base =
      `${label}  ·  start +${fmtOffset(extentOf(sel.row).start - this.viewStart())}` +
      `  self ${fmtDuration(sel.row.kind === "span" ? sel.row.span.selfMs : sel.row.round.durationMs, { minutes: true })}`;
    return this.message ? `${base}  ${this.message}` : base;
  }

  private rowText(item: FlameRow): string {
    if (item.row.kind === "round") {
      const round = item.row.round;
      return [
        `LLM call ${round.index + 1}`,
        ...(round.decision === undefined ? [] : [`decision · ${decisionSummary(round.decision)}`]),
        `${fmtTokens(round.contextTokens)} in`,
        fmtUsd(round.costUsd),
      ]
        .filter((part) => part.length > 0)
        .join(" · ");
    }
    return `${this.mark(item)}${this.threadLabel(item.node) ?? new RowLabel(item.node).computeText()}`;
  }

  /** ✖ for a span that logged an error itself, ⏸ for a tool waiting on a
   *  person. The tool status comes from the story outline, so the timeline
   *  and the trace never disagree about a tool. */
  private mark(item: FlameRow): string {
    if (item.row.kind !== "span") {
      return "";
    }
    if (holdsError(item.node)) {
      return "✖ ";
    }
    return this.waitingToolIds.includes(item.row.id) ? "⏸ " : "";
  }

  private threadLabel(node: TreeNode): string | undefined {
    if (node.label !== "llmCall" || this.index === undefined) return undefined;
    return llmGroupTitle(node, this.rounds, this.index);
  }

  private renderRow(
    item: FlameRow,
    isCursor: boolean,
    window: Interval,
    widths: WidthSplit,
  ): Element {
    const identity = rowColor(item, isCursor);
    const content = joinPainted(
      ...(this.lineNumbers
        ? [lineNumber(this.allRows.indexOf(item) + 1, lineNumberWidth(this.allRows.length))]
        : []),
      this.labelPart(item, isCursor, widths.gutter, identity),
      this.barPart(item, window, widths.bar, identity),
      this.statsPart(item, widths.stats),
    );
    return paintedLine(content, {
      width:
        widths.gutter +
        widths.bar +
        widths.stats +
        (this.lineNumbers ? lineNumberWidth(this.rows.length) : 0),
      bg: isCursor ? THEME.cursorBg : undefined,
    });
  }

  private labelPart(item: FlameRow, isCursor: boolean, width: number, fg: string): Painted {
    const levels = Math.min(item.row.depth, LAYOUT.maxIndentLevels);
    const indent = " ".repeat(levels * LAYOUT.indentCells);
    const marker = isCursor ? LAYOUT.cursorMarker : LAYOUT.noMarker;
    const isThread = item.row.kind === "span" && item.node.label === "llmCall";
    const fold = this.isFolded(item.row.id) ? "▸ " : "";
    return segment(`${marker}${indent}${fold}${this.rowText(item)}`, width, {
      style: isThread ? { fg: THEME.accent, bold: true } : { fg },
    });
  }

  private barPart(item: FlameRow, window: Interval, width: number, fg: string): Painted {
    const bar = new BarComponent([extentOf(item.row)], { running: isRunning(item.row) });
    return paint(bar.computeCells(window, width), { fg });
  }

  private statsPart(item: FlameRow, width: number): Painted {
    const extent = extentOf(item.row);
    const tone = durationTone(extent.end - extent.start, this.thresholds);
    const text = `${this.statsText(item)}${hotMark(tone)}`;
    return segment(text, width, { align: "right", style: toneStyle(tone) });
  }

  private statsText(item: FlameRow): string {
    if (item.row.kind === "round") {
      return fmtDuration(item.row.round.durationMs, { minutes: true });
    }
    return new DurationCell(this.thresholds).computeText(item.row.span, 0).text;
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
      const head =
        asked !== undefined ? `llm · ${truncate(asked.replace(/\s+/g, " "), 60)}` : "llm";
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
    if (this.node.tokens !== undefined) {
      parts.push(`${fmtTokens(this.node.tokens)} tok`);
    }
    if (this.node.cost !== undefined) {
      parts.push(fmtUsd(this.node.cost));
    }
    return parts.join(" ");
  }

  private firstStringArg(): string | undefined {
    const event = childEvent(this.node, "toolCallStart") ?? childEvent(this.node, "toolCall");
    return toolArgSummary(event?.data.args) || undefined;
  }
}

/** `total`, or `total/self` when they meaningfully differ; colored by the
 *  duration thresholds so "slow" reads the same here as in the tree. */
export class DurationCell {
  constructor(private readonly thresholds: ViewerThresholds) {}

  computeText(span: TimelineSpan, width: number): { text: string; color: string | undefined } {
    const total = span.extent.end - span.extent.start;
    const totalText = fmtDuration(total, { minutes: true });
    const text =
      span.selfMs < total * 0.95
        ? `${totalText}/${fmtDuration(span.selfMs, { minutes: true })}`
        : totalText;
    return {
      text: text.padStart(width),
      color: durationColor(total, this.thresholds),
    };
  }
}

/** The trace's colors by kind, so a tool reads as a tool on every screen:
 *  the tool color, the accent an `llmCall` span's label already has, chrome
 *  for an admin span, and muted for the rest (the run, a subprocess). */
function spanColor(node: TreeNode): string {
  if (node.label === "toolExecution") {
    return THEME.kind.tool;
  }
  if (node.label === "llmCall") {
    return THEME.accent;
  }
  return ADMIN_KINDS.includes(node.label) ? THEME.chrome : THEME.muted;
}

function extentOf(row: TimelineRow): Interval {
  return row.kind === "span" ? row.span.extent : { start: row.round.start, end: row.round.end };
}

function isRunning(row: TimelineRow): boolean {
  return row.kind === "span" && row.span.running;
}

/** The cursor row reads in the text color, a span that logged an error in
 *  red, anything else in its kind's color. */
function rowColor(item: FlameRow, isCursor: boolean): string {
  if (isCursor) {
    return THEME.text;
  }
  if (item.row.kind === "span" && holdsError(item.node)) {
    return THEME.kind.error;
  }
  return item.color;
}

/** Whether an error event was logged directly in this span. */
function holdsError(node: TreeNode): boolean {
  return childEvent(node, "error") !== undefined;
}
