import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import {
  joinPainted,
  clipPainted,
  padPainted,
  paint,
  paintedLine,
  segment,
  type Painted,
  type Piece,
} from "../../tui/paint.js";
import { fmtTokens, fmtUsd } from "../format.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { overviewData, type Callout, type OverviewData, type TimeBar } from "../overviewData.js";
import { fmtDuration } from "../spanText.js";
import { THEME, threadColor } from "../theme.js";
import type { ViewerThresholds } from "../thresholds.js";
import type { Round, ThreadKey } from "../timeline/rounds.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";
import { barText, ceilingRow, columnWindow, EMPTY_CELL, stackedColumn } from "./charts.js";
import type { Screen } from "./screen.js";

const LAYOUT = {
  leftShare: 0.45,
  dividerCells: 3,
  maxTimeBars: 6,
  timeNameWidth: 22,
  timeDurationWidth: 8,
  timePercentWidth: 5,
  axisLabelWidth: 7,
  minChartRows: 6,
  maxChartRows: 10,
  minColumnCells: 2,
  maxColumnCells: 5,
  calloutLabelWidth: 10,
  calloutValueWidth: 12,
  ceilingScaleLimit: 4,
  fixedRows: 14,
};

type Panel = "time" | "callouts";

export class OverviewScreen implements Screen {
  readonly screenName = "overview" as const;
  private roots: TreeNode[];
  private data: OverviewData | undefined;
  private panel: Panel = "time";
  private timeCursor = 0;
  private calloutCursor = 0;
  private pendingFocus: string | undefined;
  private message = "";
  private following = false;
  private pageRows = 1;
  private moves = {
    by: (delta: number): void => this.moveCursor(delta),
    toTop: (): void => this.setCursor(0),
    toBottom: (): void => this.setCursor(this.panelLength() - 1),
    page: (): number => this.pageRows,
    halfPage: (): number => Math.max(1, Math.floor(this.pageRows / 2)),
  };

  constructor(
    roots: TreeNode[],
    private traceId: string,
    private readonly thresholds: ViewerThresholds,
    private readonly contextWindowOf: (model: string) => number | undefined,
  ) {
    this.roots = roots;
    this.derive();
  }

  private bindings(): ViewerBinding[] {
    return [
      ...cursorBindings<ViewAction>(this.moves),
      {
        keys: ["Tab"],
        help: "move between the time panel and the callouts",
        hint: "tab panel",
        run: () => this.togglePanel(),
      },
      {
        keys: ["Enter"],
        help: "open the selected group's occurrences, or the selected round in the trace",
        hint: "⏎ open",
        run: () => this.openSelected(),
      },
    ];
  }

  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    this.message = "";
    this.pageRows = Math.max(1, viewport.rows - LAYOUT.fixedRows);
    return runViewerKey(this.bindings(), formatKey(event));
  }

  helpLines(): string[] {
    return helpFrom(this.bindings());
  }

  render(viewport: Viewport): Element {
    const data = this.data;
    if (data === undefined) {
      return column(
        { justifyContent: "flex-start" },
        paintedLine(segment("No trace selected.", viewport.cols, { style: { fg: THEME.muted } })),
      );
    }
    const leftWidth = Math.floor((viewport.cols - LAYOUT.dividerCells) * LAYOUT.leftShare);
    const rightWidth = viewport.cols - leftWidth - LAYOUT.dividerCells;
    const chartHeight = Math.max(
      LAYOUT.minChartRows,
      Math.min(LAYOUT.maxChartRows, Math.floor((viewport.rows - LAYOUT.fixedRows) / 2)),
    );
    const left = [
      ...this.timePanel(data, leftWidth),
      paint(""),
      ...this.costPanel(data, leftWidth, chartHeight),
    ];
    const right = [
      ...this.contextPanel(data, rightWidth, chartHeight),
      paint(""),
      ...this.factsPanel(data, rightWidth),
    ];
    const bodyRows = Math.max(left.length, right.length);
    const body = Array.from({ length: bodyRows }, (_unused, position) =>
      paintedLine(
        joinPainted(
          fitPainted(left[position] ?? paint(""), leftWidth),
          segment(" │ ", LAYOUT.dividerCells, { style: { fg: THEME.rule } }),
          fitPainted(right[position] ?? paint(""), rightWidth),
        ),
      ),
    );
    return column(
      { justifyContent: "flex-start" },
      paintedLine(
        segment(this.header(data), viewport.cols, { style: { fg: THEME.text, bold: true } }),
      ),
      ...body,
      paintedLine(segment(this.message, viewport.cols, { style: { fg: THEME.muted } })),
      paintedLine(
        segment(hintsFrom(this.bindings()), viewport.cols, { style: { fg: THEME.muted } }),
      ),
    );
  }

  setData(roots: TreeNode[]): void {
    this.roots = roots;
    this.derive();
  }

  focusId(): string | undefined {
    return this.pendingFocus;
  }

  setFocus(id: string): void {
    this.pendingFocus = id;
  }

  setTrace(traceId: string): void {
    this.traceId = traceId;
    this.panel = "time";
    this.timeCursor = 0;
    this.calloutCursor = 0;
    this.pendingFocus = undefined;
    this.derive();
  }

  escape(): boolean {
    return false;
  }

  applySearch(_query: string): void {}

  notify(message: string): void {
    this.message = message;
  }

  setFollowIndicator(on: boolean): void {
    this.following = on;
  }

  private derive(): void {
    const trace = this.roots.find((root) => root.traceId === this.traceId) ?? this.roots[0];
    this.data = trace === undefined ? undefined : overviewData(trace, this.contextWindowOf);
    this.timeCursor = clampCursor(this.timeCursor, this.data?.timeBars.length ?? 0);
    this.calloutCursor = clampCursor(this.calloutCursor, this.data?.callouts.length ?? 0);
  }

  private togglePanel(): ViewAction {
    this.panel = this.panel === "time" ? "callouts" : "time";
    return { kind: "none" };
  }

  private openSelected(): ViewAction {
    if (this.data === undefined) {
      return { kind: "none" };
    }
    if (this.panel === "time") {
      const selected = this.data.timeBars[this.timeCursor];
      return selected === undefined || selected.key === "other"
        ? { kind: "none" }
        : { kind: "openOccurrences", groupKey: selected.key };
    }
    const selected = this.data.callouts[this.calloutCursor];
    return selected === undefined
      ? { kind: "none" }
      : { kind: "openScreen", screen: "trace", focusId: selected.round.id };
  }

  private moveCursor(delta: number): void {
    this.setCursor(this.cursor() + delta);
  }

  private setCursor(position: number): void {
    const bounded = clampCursor(position, this.panelLength());
    if (this.panel === "time") {
      this.timeCursor = bounded;
    } else {
      this.calloutCursor = bounded;
    }
  }

  private cursor(): number {
    return this.panel === "time" ? this.timeCursor : this.calloutCursor;
  }

  private panelLength(): number {
    return this.panel === "time"
      ? (this.data?.timeBars.length ?? 0)
      : (this.data?.callouts.length ?? 0);
  }

  private header(data: OverviewData): string {
    const model = data.models.join(", ") || "unknown model";
    const state = data.running ? "● running" : "done";
    const following = this.following ? " · following" : "";
    return `${model} · ${state} · ${fmtDuration(data.elapsedMs, { minutes: true })} · ${data.rounds.length} rounds · ${fmtUsd(data.costUsd)}${following}`;
  }

  private timePanel(data: OverviewData, width: number): Painted[] {
    const bars = data.timeBars.slice(0, LAYOUT.maxTimeBars + 1);
    const largest = Math.max(...bars.map((bar) => bar.selfMs), 1);
    const barWidth = Math.max(
      1,
      width - LAYOUT.timeNameWidth - LAYOUT.timeDurationWidth - LAYOUT.timePercentWidth,
    );
    const lines: Painted[] = [sectionTitle("WHERE THE TIME WENT", width)];
    bars.forEach((bar, position) => {
      const marker = this.panel === "time" && position === this.timeCursor ? "▶ " : "  ";
      const nameStyle = { fg: bar.isLlm ? THEME.kind.assistant : THEME.kind.tool };
      lines.push(
        joinPainted(
          segment(`${marker}${bar.label}`, LAYOUT.timeNameWidth, { style: nameStyle }),
          segment(barText(bar.selfMs / largest, barWidth), barWidth, { style: nameStyle }),
          segment(fmtDuration(bar.selfMs), LAYOUT.timeDurationWidth, {
            align: "right",
            style: { fg: THEME.muted },
          }),
          segment(`${Math.round(bar.share * 100)}%`, LAYOUT.timePercentWidth, {
            align: "right",
            style: { fg: THEME.chrome },
          }),
        ),
      );
      lines.push(
        segment(`  ${bar.calls} ${bar.calls === 1 ? "call" : "calls"}`, width, {
          style: { fg: THEME.chrome, dim: true },
        }),
      );
    });
    return lines;
  }

  private contextPanel(data: OverviewData, width: number, height: number): Painted[] {
    const columns = visibleRounds(data.rounds, width, this.pendingFocus);
    const tallest = Math.max(
      ...columns.rounds.map((round) => round.contextTokens + round.outputTokens),
      1,
    );
    const ceiling = data.contextWindow;
    const scaleMax =
      ceiling !== undefined && ceiling <= tallest * LAYOUT.ceilingScaleLimit ? ceiling : tallest;
    const ceilingAt = ceiling === undefined ? undefined : ceilingRow(ceiling, scaleMax, height);
    const threadKeys = data.threads.map(threadKey);
    const cells = columns.rounds.map((round) =>
      stackedColumn([round.cachedTokens, round.freshTokens, round.outputTokens], scaleMax, height),
    );
    const rows: Painted[] = [sectionTitle("CONTEXT PER ROUND", width)];
    for (let rowPosition = 0; rowPosition < height; rowPosition += 1) {
      const axis = rowPosition === 0 ? fmtTokens(scaleMax) : rowPosition === height - 1 ? "0" : "";
      const pieces: Piece[] = [
        { text: axis.padStart(LAYOUT.axisLabelWidth - 1) + " ", style: { fg: THEME.chrome } },
      ];
      cells.forEach((columnCells, columnPosition) => {
        const band = columnCells[rowPosition];
        const round = columns.rounds[columnPosition];
        pieces.push(
          band === EMPTY_CELL && ceilingAt === rowPosition
            ? { text: "┄".repeat(columns.columnWidth), style: { fg: THEME.chrome } }
            : contextPiece(band, columns.columnWidth, round, threadKeys),
        );
        pieces.push({ text: ceilingAt === rowPosition ? "┄" : " " });
      });
      rows.push(segment(pieces, width));
    }
    rows.push(contextTicks(columns.rounds, columns.columnWidth, width));
    rows.push(
      segment(
        [
          { text: "░ cached", style: { fg: THEME.cached } },
          { text: "  ▒ fresh", style: { fg: THEME.kind.user } },
          { text: "  █ output", style: { fg: THEME.kind.assistant } },
        ],
        width,
      ),
    );
    if (data.threads.length > 1) {
      rows.push(threadLegend(data.rounds, width));
    }
    return rows;
  }

  private costPanel(data: OverviewData, width: number, height: number): Painted[] {
    const columns = visibleRounds(data.rounds, width, this.pendingFocus);
    const highest = Math.max(...columns.rounds.map((round) => round.costUsd), 0.000001);
    const cells = columns.rounds.map((round) => stackedColumn([round.costUsd], highest, height));
    const rows: Painted[] = [sectionTitle("COST PER ROUND", width)];
    for (let rowPosition = 0; rowPosition < height; rowPosition += 1) {
      const axis = rowPosition === 0 ? fmtUsd(highest) : rowPosition === height - 1 ? "$0" : "";
      const pieces: Piece[] = [
        { text: axis.padStart(LAYOUT.axisLabelWidth - 1) + " ", style: { fg: THEME.chrome } },
      ];
      cells.forEach((columnCells) => {
        const filled = columnCells[rowPosition] !== EMPTY_CELL;
        pieces.push({
          text: (filled ? "█" : " ").repeat(columns.columnWidth),
          style: { fg: THEME.kind.interrupt },
        });
        pieces.push({ text: " " });
      });
      rows.push(segment(pieces, width));
    }
    rows.push(contextTicks(columns.rounds, columns.columnWidth, width));
    return rows;
  }

  private factsPanel(data: OverviewData, width: number): Painted[] {
    const { counts } = data;
    const summary = `${counts.toolCalls} tool calls · ${counts.approved} approved · ${counts.rejected} rejected · ${counts.errors} errors`;
    return [
      sectionTitle("FACTS", width),
      segment(summary, width, {
        style: { fg: counts.errors > 0 ? THEME.kind.error : THEME.muted },
      }),
      ...data.callouts.map((callout, position) => this.calloutLine(callout, position, width)),
    ];
  }

  private calloutLine(callout: Callout, position: number, width: number): Painted {
    const selected = this.panel === "callouts" && this.calloutCursor === position;
    const middleWidth = Math.max(
      1,
      width - LAYOUT.calloutLabelWidth - LAYOUT.calloutValueWidth - 2,
    );
    return joinPainted(
      segment(`${selected ? "▶" : " "} ${callout.label}`, LAYOUT.calloutLabelWidth, {
        style: { fg: THEME.chrome },
      }),
      segment(` round ${callout.round.index + 1}`, middleWidth, { style: { fg: THEME.text } }),
      segment(callout.value, LAYOUT.calloutValueWidth, {
        align: "right",
        style: { fg: THEME.kind.user },
      }),
      segment(" →", 2, { style: { fg: THEME.accent } }),
    );
  }
}

function sectionTitle(title: string, width: number): Painted {
  const suffix = Math.max(0, width - title.length - 1);
  return segment(`${title} ${"─".repeat(suffix)}`, width, { style: { fg: THEME.accent } });
}

function fitPainted(content: Painted, width: number): Painted {
  return padPainted(clipPainted(content, width), width);
}

function clampCursor(position: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), position));
}

function threadKey(thread: ThreadKey): string {
  return `${thread.kind}:${thread.id}`;
}

function contextPiece(band: number, width: number, round: Round, threadKeys: string[]): Piece {
  if (band === EMPTY_CELL) {
    return { text: " ".repeat(width) };
  }
  if (band === 0) {
    return { text: "░".repeat(width), style: { fg: THEME.cached } };
  }
  if (band === 1) {
    const threadPosition = Math.max(0, threadKeys.indexOf(threadKey(round.thread)));
    return { text: "▒".repeat(width), style: { fg: threadColor(threadPosition) } };
  }
  return { text: "█".repeat(width), style: { fg: THEME.kind.assistant } };
}

function visibleRounds(rounds: Round[], width: number, focusId: string | undefined) {
  const available = Math.max(1, width - LAYOUT.axisLabelWidth);
  const room = Math.max(1, Math.floor(available / LAYOUT.minColumnCells));
  const focusAt = rounds.findIndex((round) => round.id === focusId);
  const window = columnWindow(rounds.length, room, focusAt === -1 ? undefined : focusAt);
  const shown = rounds.slice(window.from, window.to);
  const slot = Math.max(
    LAYOUT.minColumnCells,
    Math.min(LAYOUT.maxColumnCells, Math.floor(available / Math.max(1, shown.length))),
  );
  return { rounds: shown, columnWidth: Math.max(1, slot - 1) };
}

function contextTicks(rounds: Round[], columnWidth: number, width: number): Painted {
  const slot = columnWidth + 1;
  const ticks = rounds
    .map((round, position) =>
      position % 2 === 0 ? `r${round.index + 1}`.padEnd(slot) : " ".repeat(slot),
    )
    .join("");
  return segment(`${" ".repeat(LAYOUT.axisLabelWidth)}${ticks}`, width, {
    style: { fg: THEME.chrome },
  });
}

function threadLegend(rounds: Round[], width: number): Painted {
  const labels: Piece[] = [];
  const seen: string[] = [];
  for (const round of rounds) {
    const key = threadKey(round.thread);
    if (seen.includes(key)) {
      continue;
    }
    const position = seen.length;
    seen.push(key);
    labels.push({
      text: `${position === 0 ? "" : "  "}▒ ${round.threadLabel ?? `thread ${position + 1}`}`,
      style: { fg: threadColor(position) },
    });
  }
  return segment(labels, width);
}
