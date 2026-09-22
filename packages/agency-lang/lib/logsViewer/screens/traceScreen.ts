import { column, row } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { paint, paintedLine, segment, type Painted, type Piece } from "../../tui/paint.js";
import { TableComponent, type TableColumn } from "../../tui/table.js";
import { ancestorsOf, buildTreeIndex, walkNodes } from "../forest.js";
import { fmtTokens, fmtUsd } from "../format.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { payloadFor } from "../payload.js";
import { fmtDuration } from "../spanText.js";
import { outlineRows, type StoryRow } from "../story.js";
import { THEME, costTone, durationTone, hotMark, toneStyle } from "../theme.js";
import type { ViewerThresholds } from "../thresholds.js";
import { parseRoundId } from "../timeline/rounds.js";
import { stringsIn } from "../traceSearch.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";
import { paintPayload } from "./payloadPaint.js";
import type { Screen } from "./screen.js";
const LAYOUT = {
  outlineShare: 0.5,
  minOutlineWidth: 48,
  durationWidth: 8,
  tokensWidth: 7,
  costWidth: 9,
  dividerWidth: 1,
  fixedRows: 3,
  indent: 2,
};
type TraceOptions = { extractEnabled: boolean };
type QuickFilter = "errors" | "tools" | "interrupts" | undefined;
type PayloadCache = { key: string; lines: Painted[] };

export class TraceScreen implements Screen {
  readonly screenName = "trace" as const;
  private machinery = false;
  private admin = false;
  private raw = false;
  private collapsed: string[] = [];
  private cursorId = "";
  private scrollTop = 0;
  private pane: "outline" | "payload" = "outline";
  private paneScroll = 0;
  private filter: string | undefined;
  private quick: QuickFilter;
  private matchIds: string[] = [];
  private message = "";
  private following = false;
  private allRows: StoryRow[] = [];
  private visible: StoryRow[] = [];
  private page = 1;
  private payloadHeight = 0;
  private cache: PayloadCache | undefined;
  private table = new TableComponent<StoryRow>();
  private moves = {
    by: (delta: number): void => this.move(delta),
    toTop: (): void => this.move(-Infinity),
    toBottom: (): void => this.move(Infinity),
    page: (): number => this.page,
    halfPage: (): number => Math.max(1, Math.floor(this.page / 2)),
  };
  constructor(
    private roots: TreeNode[],
    private traceId: string,
    private readonly thresholds: ViewerThresholds,
    private readonly opts: TraceOptions,
  ) {
    this.derive();
  }
  private bindings(): ViewerBinding[] {
    return [
      ...cursorBindings<ViewAction>(this.moves),
      {
        keys: ["Enter"],
        help: "expand or collapse children",
        hint: "⏎ fold",
        run: () => this.toggleCollapsed(),
      },
      {
        keys: ["Tab"],
        help: "switch outline and payload focus",
        hint: "tab pane",
        run: () => {
          this.pane = this.pane === "outline" ? "payload" : "outline";
        },
      },
      {
        keys: ["r"],
        help: "toggle raw JSON payload",
        hint: "r raw",
        run: () => {
          this.raw = !this.raw;
          this.paneScroll = 0;
        },
      },
      {
        keys: ["m"],
        help: "toggle machinery rows",
        hint: "m machinery",
        run: () => {
          this.machinery = !this.machinery;
          this.derive();
        },
      },
      {
        keys: ["a"],
        help: "toggle admin rows",
        hint: "a admin",
        run: () => {
          this.admin = !this.admin;
          this.derive();
        },
      },
      {
        keys: ["d"],
        help: "open full-screen detail",
        hint: "d detail",
        when: () => this.selected() !== undefined,
        run: () => ({ kind: "openDetail", rowId: this.cursorId }),
      },
      {
        keys: ["/"],
        help: "filter complete payloads",
        hint: "/ find",
        run: () => ({
          kind: "promptLine",
          label: "/ ",
          onResult: (text) => this.applySearch(text),
        }),
      },
      {
        keys: ["F"],
        help: "cycle errors, tools, interrupts and all rows",
        hint: "F filter",
        run: () => {
          const choices: QuickFilter[] = [undefined, "errors", "tools", "interrupts"];
          this.quick = choices[(choices.indexOf(this.quick) + 1) % choices.length];
          this.filterRows();
        },
      },
      { keys: ["n"], help: "next match", run: () => this.nextMatch(1) },
      { keys: ["N"], help: "previous match", run: () => this.nextMatch(-1) },
      {
        keys: ["y"],
        help: "copy focused event or span events as JSON",
        run: () => ({ kind: "copy", text: this.copyText() }),
      },
      {
        keys: ["Y"],
        help: "copy trace as JSONL",
        run: () => ({ kind: "copyTrace", traceId: this.traceId }),
      },
      {
        keys: ["x"],
        help: "extract trace",
        when: () => this.opts.extractEnabled,
        run: () => ({ kind: "extractTrace", traceId: this.traceId }),
      },
    ];
  }
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    this.message = "";
    this.page = Math.max(1, viewport.rows - LAYOUT.fixedRows);
    if (this.pane === "payload") {
      this.payloadHeight = this.payload(this.payloadWidth(viewport.cols)).length;
    }
    return runViewerKey(this.bindings(), formatKey(event));
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
  rowCount(): number {
    return this.visible.length;
  }
  private trace(): TreeNode | undefined {
    return this.roots.find((root) => root.traceId === this.traceId);
  }
  private selected(): StoryRow | undefined {
    return this.allRows.find((row) => row.id === this.cursorId);
  }
  private derive(): void {
    const old = this.selected();
    const oldAncestors = old ? rowAncestors(this.allRows, old).map((row) => row.id) : [];
    const trace = this.trace();
    this.allRows = trace
      ? outlineRows(trace, { machinery: this.machinery, admin: this.admin })
      : [];
    if (!this.allRows.some((row) => row.id === this.cursorId)) {
      const fallback = oldAncestors.find((id) => this.allRows.some((row) => row.id === id));
      this.cursorId = fallback ?? this.ancestorFallback(old?.node) ?? this.allRows[0]?.id ?? "";
    }
    this.cache = undefined;
    this.filterRows();
  }
  private ancestorFallback(node: TreeNode | undefined): string | undefined {
    const trace = this.trace();
    if (!trace || !node) {
      return undefined;
    }
    return ancestorsOf(node, buildTreeIndex(trace))
      .map((ancestor) => this.allRows.find((row) => row.node.id === ancestor.id)?.id)
      .find((id) => id !== undefined);
  }
  private filterRows(): void {
    const matches = this.allRows.filter((row) => this.matches(row));
    this.matchIds = this.filter || this.quick ? matches.map((row) => row.id) : [];
    const keep = matches.flatMap((row) => [
      row.id,
      ...rowAncestors(this.allRows, row).map((ancestor) => ancestor.id),
    ]);
    this.visible = this.allRows.filter((row) => {
      if (!keep.includes(row.id)) {
        return false;
      }
      return (
        this.filter ||
        this.quick ||
        !rowAncestors(this.allRows, row).some((ancestor) => this.collapsed.includes(ancestor.id))
      );
    });
    if (!this.visible.some((row) => row.id === this.cursorId)) {
      this.select(this.visible[0]?.id ?? "");
    }
    this.clampOutline();
  }
  private matches(row: StoryRow): boolean {
    if (
      this.quick === "errors" &&
      !(
        row.kind === "error" ||
        (row.kind === "tool" && ["failed", "rejected"].includes(row.status))
      )
    ) {
      return false;
    }
    if (this.quick === "tools" && row.kind !== "tool") {
      return false;
    }
    if (this.quick === "interrupts" && row.kind !== "interrupt") {
      return false;
    }
    if (!this.filter) {
      return true;
    }
    const events = row.node.event
      ? [row.node.event]
      : row.node.children.flatMap((child) => (child.event ? [child.event] : []));
    const text = [
      ...events.flatMap((event) => stringsIn(event.data)),
      ...stringsIn(row.kind === "user" ? row.text : row.node.summary),
    ].join("\n");
    return text.toLowerCase().includes(this.filter.toLowerCase());
  }
  private select(id: string): void {
    if (id !== this.cursorId) {
      this.paneScroll = 0;
    }
    this.cursorId = id;
    this.clampOutline();
  }
  private clampOutline(): void {
    const position = this.visible.findIndex((row) => row.id === this.cursorId);
    if (position < this.scrollTop) {
      this.scrollTop = Math.max(0, position);
    }
    if (position >= this.scrollTop + this.page) {
      this.scrollTop = position - this.page + 1;
    }
    this.scrollTop = Math.max(
      0,
      Math.min(this.scrollTop, Math.max(0, this.visible.length - this.page)),
    );
  }
  private move(delta: number): void {
    if (this.pane === "payload") {
      this.paneScroll = Math.max(
        0,
        Math.min(this.paneScroll + delta, Math.max(0, this.payloadHeight - this.page)),
      );
      return;
    }
    const position = this.visible.findIndex((row) => row.id === this.cursorId);
    const next = Math.max(0, Math.min(position + delta, this.visible.length - 1));
    this.select(this.visible[next]?.id ?? "");
  }
  private toggleCollapsed(): void {
    this.collapsed = this.collapsed.includes(this.cursorId)
      ? this.collapsed.filter((id) => id !== this.cursorId)
      : [...this.collapsed, this.cursorId];
    this.filterRows();
  }
  private nextMatch(direction: number): void {
    if (this.matchIds.length === 0) {
      return;
    }
    const position = this.matchIds.indexOf(this.cursorId);
    const start = position < 0 && direction < 0 ? 0 : position;
    const next = (start + direction + this.matchIds.length) % this.matchIds.length;
    this.setFocus(this.matchIds[next]);
  }
  applySearch(query: string): void {
    this.filter = query || undefined;
    this.filterRows();
  }
  escape(): boolean {
    if (this.pane === "payload") {
      this.pane = "outline";
      return true;
    }
    if (this.filter || this.quick) {
      this.filter = undefined;
      this.quick = undefined;
      this.filterRows();
      return true;
    }
    return false;
  }
  focusId(): string | undefined {
    const row = this.selected();
    if (!row) {
      return undefined;
    }
    if (travels(row)) {
      return row.id;
    }
    if (row.kind === "user") {
      return row.id.slice(0, -":user".length);
    }
    const ancestor = rowAncestors(this.allRows, row).find(travels);
    return ancestor?.id;
  }
  setFocus(id: string): void {
    let target = this.allRows.find((row) => row.id === id);
    const trace = this.trace();
    if (!target && trace) {
      const index = buildTreeIndex(trace);
      const node = index.byId[parseRoundId(id)?.spanId ?? id];
      if (node) {
        target =
          this.allRows.find((row) => travels(row) && walkNodes(node).includes(row.node)) ??
          this.allRows.find((row) => row.id === this.ancestorFallback(node));
      }
    }
    if (!target) {
      return;
    }
    if ((this.filter || this.quick) && !this.visible.some((row) => row.id === target.id)) {
      this.filter = undefined;
      this.quick = undefined;
    }
    const ancestorIds = rowAncestors(this.allRows, target).map((row) => row.id);
    this.collapsed = this.collapsed.filter((id) => !ancestorIds.includes(id));
    this.cursorId = target.id;
    this.paneScroll = 0;
    this.filterRows();
  }
  setData(roots: TreeNode[]): void {
    this.roots = roots;
    this.derive();
  }
  setTrace(traceId: string): void {
    this.traceId = traceId;
    this.cursorId = "";
    this.collapsed = [];
    this.filter = undefined;
    this.quick = undefined;
    this.scrollTop = 0;
    this.paneScroll = 0;
    this.derive();
  }
  private copyText(): string {
    const row = this.selected();
    if (!row) {
      return "";
    }
    const events = row.node.event
      ? row.node.event
      : walkNodes(row.node).flatMap((node) => (node.event ? [node.event] : []));
    return JSON.stringify(events, null, 2);
  }
  private outlineWidth(cols: number): number {
    return Math.max(LAYOUT.minOutlineWidth, Math.floor(cols * LAYOUT.outlineShare));
  }
  private payloadWidth(cols: number): number {
    return Math.max(1, cols - this.outlineWidth(cols) - LAYOUT.dividerWidth);
  }
  private payload(width: number): Painted[] {
    const selected = this.selected();
    if (!selected) {
      return [];
    }
    const key = JSON.stringify([this.cursorId, this.raw, width]);
    if (this.cache?.key !== key) {
      this.cache = { key, lines: paintPayload(payloadFor(selected, { raw: this.raw }), width) };
    }
    return this.cache.lines;
  }
  render(viewport: Viewport): Element {
    this.page = Math.max(1, viewport.rows - LAYOUT.fixedRows);
    this.clampOutline();
    const width = this.outlineWidth(viewport.cols);
    const payload = this.payload(this.payloadWidth(viewport.cols));
    this.payloadHeight = payload.length;
    this.paneScroll = Math.max(
      0,
      Math.min(this.paneScroll, Math.max(0, payload.length - this.page)),
    );
    const shown = this.visible.slice(this.scrollTop, this.scrollTop + this.page);
    const table = this.table.render({
      columns: this.columns(),
      rows: shown,
      cursor: shown.findIndex((row) => row.id === this.cursorId),
      width,
      showHeader: false,
      cursorBg: THEME.cursorBg,
    });
    const outline = column(
      { width, height: this.page, justifyContent: "flex-start" },
      table,
      ...(shown.length === 0 ? [paintedLine(paint("No matching rows", { fg: THEME.muted }))] : []),
    );
    const divider = column(
      { width: LAYOUT.dividerWidth, height: this.page },
      ...Array.from({ length: this.page }, () =>
        paintedLine(
          paint(this.pane === "outline" ? "┃" : "│", {
            fg: this.pane === "outline" ? THEME.accent : THEME.chrome,
          }),
        ),
      ),
    );
    const body = column(
      { width: this.payloadWidth(viewport.cols), height: this.page, justifyContent: "flex-start" },
      ...payload
        .slice(this.paneScroll, this.paneScroll + this.page)
        .map((line) => paintedLine(line)),
    );
    const hidden = this.allRows.length - this.rowCount();
    return column(
      { height: viewport.rows, justifyContent: "flex-start" },
      paintedLine(
        segment(`TRACE ${this.traceId}${this.following ? " · following" : ""}`, viewport.cols, {
          style: { fg: THEME.accent },
        }),
      ),
      paintedLine(
        segment(
          `${this.filter ? `/${this.filter} ` : ""}${this.quick ?? "all"} · ${hidden} hidden${this.machinery ? " · machinery" : ""}${this.admin ? " · admin" : ""} · ${this.pane} focus${this.raw ? " · raw" : ""}`,
          viewport.cols,
          { style: { fg: THEME.muted } },
        ),
      ),
      row({ height: this.page }, outline, divider, body),
      paintedLine(
        segment(this.message || hintsFrom(this.bindings()), viewport.cols, {
          style: { fg: THEME.chrome },
        }),
      ),
    );
  }
  private columns(): TableColumn<StoryRow>[] {
    return [
      {
        key: "story",
        header: "",
        width: "flex",
        cell: (row) => rowPieces(row, row.id === this.cursorId, this.collapsed.includes(row.id)),
      },
      {
        key: "duration",
        header: "",
        width: LAYOUT.durationWidth,
        align: "right",
        cell: (row) => {
          const duration = durationOf(row);
          if (duration === undefined) {
            return row.kind === "tool" ? "—" : "";
          }
          return fmtDuration(duration) + hotMark(durationTone(duration, this.thresholds));
        },
        cellStyle: (row) => toneStyle(durationTone(durationOf(row) ?? 0, this.thresholds)),
      },
      {
        key: "tokens",
        header: "",
        width: LAYOUT.tokensWidth,
        align: "right",
        cell: (row) => (row.kind === "round" ? fmtTokens(row.round.contextTokens) : ""),
        cellStyle: () => ({ fg: THEME.muted }),
      },
      {
        key: "cost",
        header: "",
        width: LAYOUT.costWidth,
        align: "right",
        cell: (row) =>
          row.kind === "round"
            ? fmtUsd(row.round.costUsd) + hotMark(costTone(row.round.costUsd, this.thresholds))
            : "",
        cellStyle: (row) =>
          toneStyle(costTone(row.kind === "round" ? row.round.costUsd : 0, this.thresholds)),
      },
    ];
  }
}
function travels(row: StoryRow): boolean {
  return ["round", "tool", "subagent"].includes(row.kind);
}
function rowAncestors(rows: StoryRow[], row: StoryRow): StoryRow[] {
  const ancestors: StoryRow[] = [];
  let depth = row.depth;
  for (let position = rows.indexOf(row) - 1; position >= 0; position--) {
    if (rows[position].depth < depth) {
      ancestors.push(rows[position]);
      depth = rows[position].depth;
    }
  }
  return ancestors;
}
function durationOf(row: StoryRow): number | undefined {
  if (row.kind === "round") {
    return row.round.durationMs;
  }
  if (row.kind === "tool") {
    return row.durationMs;
  }
  return undefined;
}
function rowPieces(row: StoryRow, selected: boolean, collapsed: boolean): Piece[] {
  const prefix: Piece[] = [
    {
      text: `${selected ? "▶" : " "} ${" ".repeat(row.depth * LAYOUT.indent)}${collapsed ? "▸ " : ""}`,
    },
  ];
  switch (row.kind) {
    case "round":
      return [
        ...prefix,
        {
          text: `round ${String(row.round.index + 1).padStart(2)} `,
          style: { fg: THEME.kind.assistant, bold: true },
        },
        { text: row.gist, style: { fg: THEME.text } },
      ];
    case "tool":
      return [
        ...prefix,
        {
          text: `${["failed", "rejected"].includes(row.status) ? "✖ " : ""}${row.name} `,
          style: {
            fg: ["failed", "rejected"].includes(row.status) ? THEME.kind.error : THEME.kind.tool,
          },
        },
        { text: row.argSummary, style: { fg: THEME.text } },
      ];
    case "interrupt":
      return [
        ...prefix,
        { text: `⚠ ${row.interrupt.effect} `, style: { fg: THEME.kind.interrupt } },
        {
          text: row.interrupt.outcome,
          style: { fg: row.interrupt.outcome === "approved" ? THEME.ok : THEME.kind.error },
        },
      ];
    case "error":
      return [...prefix, { text: `✖ ${row.message}`, style: { fg: THEME.kind.error } }];
    case "user":
      return [
        ...prefix,
        { text: "user ", style: { fg: THEME.kind.user } },
        { text: row.text, style: { fg: THEME.text } },
      ];
    case "subagent":
      return [...prefix, { text: `subagent ${row.label}`, style: { fg: THEME.kind.assistant } }];
    case "machinery":
      return [...prefix, { text: row.text, style: { fg: THEME.chrome } }];
  }
}
