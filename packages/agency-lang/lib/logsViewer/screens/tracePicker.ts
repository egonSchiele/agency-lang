import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { segment, paintedLine } from "../../tui/paint.js";
import { TableComponent, type TableColumn } from "../../tui/table.js";
import { fmtTokens, fmtUsd } from "../format.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { fmtDuration } from "../spanText.js";
import { THEME, costTone, durationTone, toneStyle, hotMark } from "../theme.js";
import type { ViewerThresholds } from "../thresholds.js";
import { traceSummaries, type TraceSummary } from "../traceSummaries.js";
import {
  traceTexts,
  searchTraces,
  textFilter,
  applyFilters,
  type TraceText,
  type TraceHit,
  type TraceFilter,
} from "../traceSearch.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "../views/view.js";

const LAYOUT = {
  chromeRows: 6,
  startedWidth: 10,
  durationWidth: 9,
  roundsWidth: 7,
  tokensWidth: 8,
  costWidth: 9,
  hitsWidth: 5,
  markerWidth: 3,
};
export type TracePickerOptions = {
  currentTraceId: string;
  annotations: Record<string, string>;
  thresholds: ViewerThresholds;
};
type ShownTraces = { summaries: TraceSummary[]; hits: TraceHit[]; searching: boolean };
export class TracePicker implements View {
  readonly viewName = "tracePicker" as const;
  private summaries: TraceSummary[] = [];
  private texts: TraceText[] = [];
  private query = "";
  private editing = false;
  private extraFilters: TraceFilter[] = [];
  private cursorTraceId: string;
  private scrollTop = 0;
  private pageRows = 1;
  private message = "";
  private following = false;
  constructor(
    roots: TreeNode[],
    private readonly options: TracePickerOptions,
  ) {
    this.cursorTraceId = options.currentTraceId;
    this.setData(roots);
  }
  private moves = {
    by: (delta: number) => this.move(delta),
    toTop: () => this.move(-Infinity),
    toBottom: () => this.move(Infinity),
    page: () => this.pageRows,
    halfPage: () => Math.max(1, Math.floor(this.pageRows / 2)),
  };
  private browsingBindings(): ViewerBinding[] {
    return [
      ...cursorBindings<ViewAction>(this.moves),
      {
        keys: ["Enter"],
        help: "open the selected trace",
        hint: "⏎ open",
        run: () => this.openSelected(),
      },
      {
        keys: ["/"],
        help: "search the text of every trace",
        hint: "/ search",
        run: () => {
          this.editing = true;
        },
      },
    ];
  }
  private editingBindings(): ViewerBinding[] {
    return [
      {
        keys: ["Enter"],
        help: "keep the search and browse the results",
        hint: "⏎ done",
        run: () => {
          this.editing = false;
        },
      },
      {
        keys: ["Backspace"],
        help: "delete a character",
        run: () => {
          this.query = this.query.slice(0, -1);
          this.keepCursorVisible();
        },
      },
      { keys: ["Space"], help: "a space in the search", run: () => this.appendToQuery(" ") },
    ];
  }
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    this.pageRows = Math.max(1, viewport.rows - LAYOUT.chromeRows);
    if (this.editing && event.key === "paste") {
      this.appendToQuery(event.text ?? "");
      return { kind: "none" };
    }
    if (this.editing && event.key.length === 1 && !event.ctrl) {
      this.appendToQuery(event.key);
      return { kind: "none" };
    }
    return runViewerKey(
      this.editing ? this.editingBindings() : this.browsingBindings(),
      formatKey(event),
    );
  }
  capturesText(): boolean {
    return this.editing;
  }
  escape(): boolean {
    if (this.editing || this.query.length > 0) {
      this.query = "";
      this.editing = false;
      this.keepCursorVisible();
      return true;
    }
    return false;
  }
  setData(roots: TreeNode[]): void {
    this.summaries = traceSummaries(roots, this.options.annotations);
    this.texts = traceTexts(roots);
    this.keepCursorVisible();
  }
  setFollowIndicator(on: boolean): void {
    this.following = on;
  }
  notify(message: string): void {
    this.message = message;
  }
  helpLines(): string[] {
    return helpFrom(this.editing ? this.editingBindings() : this.browsingBindings());
  }
  private shown(): ShownTraces {
    const hits = searchTraces(this.texts, this.query);
    const searching = this.query.length > 0;
    const filters = searching
      ? [textFilter(this.query, hits), ...this.extraFilters]
      : this.extraFilters;
    return { summaries: applyFilters(this.summaries, filters), hits, searching };
  }
  private appendToQuery(text: string): void {
    this.query += text;
    this.keepCursorVisible();
  }
  private keepCursorVisible(): void {
    const shown = this.shown().summaries;
    if (!shown.some((summary) => summary.traceId === this.cursorTraceId)) {
      this.cursorTraceId = shown[0]?.traceId ?? "";
      this.scrollTop = 0;
    }
  }
  private move(delta: number): void {
    const summaries = this.shown().summaries;
    const position = summaries.findIndex((summary) => summary.traceId === this.cursorTraceId);
    const next = Math.max(0, Math.min(summaries.length - 1, position + delta));
    this.cursorTraceId = summaries[next]?.traceId ?? "";
  }
  private openSelected(): ViewAction {
    if (!this.shown().summaries.some((summary) => summary.traceId === this.cursorTraceId)) {
      return { kind: "none" };
    }
    if (this.query.length > 0) {
      return { kind: "selectTrace", traceId: this.cursorTraceId, query: this.query };
    }
    return { kind: "selectTrace", traceId: this.cursorTraceId };
  }
  render(viewport: Viewport): Element {
    const shown = this.shown();
    const title = shown.searching
      ? `TRACES · ${shown.summaries.length} of ${this.summaries.length} match "${this.query}"`
      : `TRACES · ${this.summaries.length}`;
    const table = new TableComponent<TraceSummary>().render({
      columns: this.columns(shown),
      rows: shown.summaries,
      cursor: shown.summaries.findIndex((summary) => summary.traceId === this.cursorTraceId),
      width: viewport.cols,
    });
    const tableRows = table.children ?? [];
    const body: Element[] = [];
    let cursorLine = 0;
    shown.summaries.forEach((summary, position) => {
      if (summary.traceId === this.cursorTraceId) {
        cursorLine = body.length;
      }
      body.push(tableRows[position + 1]);
      if (summary.annotation !== undefined) {
        body.push(
          paintedLine(
            segment(`   ${summary.annotation}`, viewport.cols, { style: { fg: THEME.muted } }),
          ),
        );
      }
    });
    const height = Math.max(1, viewport.rows - LAYOUT.chromeRows);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, cursorLine));
    if (cursorLine >= this.scrollTop + height) {
      this.scrollTop = cursorLine - height + 1;
    }
    const hit = shown.hits.find((entry) => entry.traceId === this.cursorTraceId);
    const footer = hintsFrom(this.editing ? this.editingBindings() : this.browsingBindings());
    return column(
      { justifyContent: "flex-start" },
      paintedLine(segment(title, viewport.cols, { style: { fg: THEME.accent, bold: true } })),
      paintedLine(segment(`/ ${this.query}${this.editing ? "▏" : ""}`, viewport.cols)),
      tableRows[0],
      column(
        { height, justifyContent: "flex-start" },
        ...body.slice(this.scrollTop, this.scrollTop + height),
      ),
      paintedLine(
        segment(hit === undefined ? "" : `first hit: ${hit.snippet}`, viewport.cols, {
          style: { fg: THEME.muted },
        }),
      ),
      paintedLine(segment(this.message || (this.following ? "● following" : ""), viewport.cols)),
      paintedLine(segment(footer, viewport.cols, { style: { fg: THEME.muted } })),
    );
  }
  private columns(shown: ShownTraces): TableColumn<TraceSummary>[] {
    const thresholds = this.options.thresholds;
    const columns: TableColumn<TraceSummary>[] = [
      {
        key: "current",
        header: "",
        width: LAYOUT.markerWidth,
        cell: (summary) => (summary.traceId === this.options.currentTraceId ? "●" : ""),
      },
      {
        key: "started",
        header: "started",
        width: LAYOUT.startedWidth,
        cell: (summary) =>
          summary.startedAt === undefined
            ? "—"
            : new Date(summary.startedAt).toISOString().slice(11, 19),
      },
      {
        key: "duration",
        header: "duration",
        width: LAYOUT.durationWidth,
        cell: (summary) => fmtDuration(summary.durationMs, { minutes: true }),
        cellStyle: (summary) => toneStyle(durationTone(summary.durationMs ?? 0, thresholds)),
      },
      {
        key: "rounds",
        header: "rounds",
        width: LAYOUT.roundsWidth,
        align: "right",
        cell: (summary) => String(summary.rounds),
      },
      {
        key: "context",
        header: "context",
        width: LAYOUT.tokensWidth,
        align: "right",
        cell: (summary) => fmtTokens(summary.tokens),
      },
      {
        key: "cost",
        header: "cost",
        width: LAYOUT.costWidth,
        align: "right",
        cell: (summary) =>
          `${fmtUsd(summary.costUsd)}${hotMark(costTone(summary.costUsd, thresholds))}`,
        cellStyle: (summary) => toneStyle(costTone(summary.costUsd, thresholds)),
      },
    ];
    if (shown.searching) {
      columns.push({
        key: "hits",
        header: "hits",
        width: LAYOUT.hitsWidth,
        align: "right",
        cell: (summary) =>
          String(shown.hits.find((hit) => hit.traceId === summary.traceId)?.count ?? 0),
      });
    }
    columns.push({
      key: "what",
      header: "what",
      width: "flex",
      cell: (summary) => [
        { text: summary.hasError ? "✖ " : "", style: { fg: THEME.kind.error } },
        { text: summary.ask ?? summary.traceId },
      ],
    });
    return columns;
  }
}
