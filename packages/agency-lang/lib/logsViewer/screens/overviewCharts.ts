import { paint, segment, type Painted, type Piece } from "../../tui/paint.js";
import { fmtTokens, fmtUsd } from "../format.js";
import { fmtDuration } from "../spanText.js";
import { THEME, threadColor } from "../theme.js";
import { threadNames, type OverviewCall } from "../overviewData.js";
import { ceilingRow, columnWindow, EMPTY_CELL, stackedColumn } from "./charts.js";

const AXIS_WIDTH = 10;
const MIN_SLOT = 3;
const MAX_SLOT = 5;
const CHART_COUNT = 3;
const CHROME_ROWS = 9; // Three headings and axes, context legend, two gaps.
const CEILING_SCALE_LIMIT = 4;
type Chart = { title: string; max: number; label: string; color: string; values: number[] };
type ChartLayout = {
  width: number;
  height: number;
  columnWidth: number;
  selectedId: string | undefined;
  /** Whether a ✖ row is drawn under each chart's call numbers. */
  marks: boolean;
  /** Thread names in color order; a call number takes its thread's color. */
  threads: string[];
};

export function overviewCharts(
  calls: OverviewCall[],
  selectedId: string | undefined,
  width: number,
  height: number,
  ceiling: number | undefined,
): Painted[] {
  const available = Math.max(1, width - AXIS_WIDTH);
  const minSlot = Math.max(MIN_SLOT, String(calls.length).length + 1);
  const room = overviewCallCapacity(calls.length, width);
  const selectedAt = Math.max(
    0,
    calls.findIndex((call) => call.id === selectedId),
  );
  const window = columnWindow(calls.length, room, selectedAt);
  const shown = calls.slice(window.from, window.to);
  const slot = Math.min(
    Math.max(MAX_SLOT, minSlot),
    Math.floor(available / Math.max(1, shown.length)),
  );
  // The ✖ row only appears when something went wrong, so a clean run keeps
  // its chart height.
  const marks = calls.some((call) => call.errors.length > 0);
  const threads = threadNames(calls);
  // A threads legend only when there is more than one thread to tell apart.
  const chrome = CHROME_ROWS + (marks ? CHART_COUNT : 0) + (threads.length > 1 ? 1 : 0);
  const layout = {
    width,
    height: Math.max(0, Math.floor((height - chrome) / CHART_COUNT)),
    columnWidth: Math.max(1, slot - 1),
    selectedId,
    marks,
    threads,
  };
  const rounds = calls.flatMap((call) => (call.round === undefined ? [] : [call.round]));
  const maxContext = Math.max(
    1,
    ...rounds.map((round) => round.contextTokens + round.outputTokens),
  );
  const contextScale =
    ceiling !== undefined && ceiling > maxContext && ceiling <= maxContext * CEILING_SCALE_LIMIT
      ? ceiling
      : maxContext;
  const maxCost = Math.max(0, ...rounds.map((round) => round.costUsd));
  const maxTime = Math.max(0, ...rounds.map((round) => round.durationMs));
  return [
    ...contextChart(shown, layout, contextScale, ceiling),
    paint(""),
    ...metricChart(shown, layout, {
      title: "COST PER LLM CALL",
      max: maxCost,
      label: fmtCost(maxCost),
      color: THEME.kind.interrupt,
      values: shown.map((call) => call.round?.costUsd ?? 0),
    }),
    paint(""),
    ...metricChart(shown, layout, {
      title: "TIME PER LLM CALL",
      max: maxTime,
      label: fmtDuration(maxTime),
      color: THEME.kind.user,
      values: shown.map((call) => call.round?.durationMs ?? 0),
    }),
  ];
}

/** Number of calls that fit across any of the three overview charts. */
export function overviewCallCapacity(count: number, width: number): number {
  const available = Math.max(1, width - AXIS_WIDTH);
  const minSlot = Math.max(MIN_SLOT, String(count).length + 1);
  return Math.max(1, Math.floor(available / minSlot));
}

export function overviewSection(title: string, width: number): Painted {
  return segment(`${title} ${"─".repeat(Math.max(0, width - title.length - 1))}`, width, {
    style: { fg: THEME.accent },
  });
}

function contextChart(
  calls: OverviewCall[],
  layout: ChartLayout,
  max: number,
  ceiling: number | undefined,
): Painted[] {
  const columns = calls.map((call) =>
    stackedColumn(
      call.round === undefined
        ? [0, 0, 0]
        : [call.round.cachedTokens, call.round.freshTokens, call.round.outputTokens],
      max,
      layout.height,
    ),
  );
  const ceilingAt = ceiling === undefined ? undefined : ceilingRow(ceiling, max, layout.height);
  const glyphs = ["░", "▒", "█"];
  const colors = [THEME.cached, THEME.kind.user, THEME.kind.assistant];
  const rows = Array.from({ length: layout.height }, (_, row) => {
    const pieces: Piece[] = [
      axis(row === 0 ? fmtTokens(max) : row === layout.height - 1 ? "0" : ""),
    ];
    columns.forEach((cells, index) => {
      const band = cells[row];
      const glyph = band === EMPTY_CELL ? (row === ceilingAt ? "┄" : " ") : glyphs[band];
      pieces.push(columnPiece(glyph, colors[band] ?? THEME.chrome, calls[index], layout), {
        text: " ",
      });
    });
    return segment(pieces, layout.width);
  });
  return [
    overviewSection("CONTEXT PER LLM CALL", layout.width),
    ...rows,
    ...ticks(calls, layout),
    segment(
      [
        { text: "░ cached", style: { fg: THEME.cached } },
        { text: "  ▒ fresh", style: { fg: THEME.kind.user } },
        { text: "  █ output", style: { fg: THEME.kind.assistant } },
        ...(layout.marks ? [{ text: "  ✖ failed", style: { fg: THEME.kind.error } }] : []),
      ],
      layout.width,
    ),
    ...(layout.threads.length > 1 ? [threadsLegend(layout)] : []),
  ];
}

function threadsLegend(layout: ChartLayout): Painted {
  return segment(
    [
      { text: "threads", style: { fg: THEME.muted } },
      ...layout.threads.map((name, position) => ({
        text: `  ■ ${name}`,
        style: { fg: threadColor(position) },
      })),
    ],
    layout.width,
  );
}

function metricChart(calls: OverviewCall[], layout: ChartLayout, chart: Chart): Painted[] {
  const columns = chart.values.map((value) => verticalColumn(value, chart.max, layout.height));
  const rows = Array.from({ length: layout.height }, (_, row) => {
    const pieces: Piece[] = [axis(row === 0 ? chart.label : row === layout.height - 1 ? "0" : "")];
    columns.forEach((cells, index) =>
      pieces.push(columnPiece(cells[row], chart.color, calls[index], layout), { text: " " }),
    );
    return segment(pieces, layout.width);
  });
  return [overviewSection(chart.title, layout.width), ...rows, ...ticks(calls, layout)];
}

function columnPiece(glyph: string, color: string, call: OverviewCall, layout: ChartLayout): Piece {
  return {
    text: glyph.repeat(layout.columnWidth),
    style: {
      fg: color,
      ...(call.id === layout.selectedId ? { bg: THEME.cursorBg, bold: true } : {}),
    },
  };
}
function axis(label: string): Piece {
  const fitted = label.length < AXIS_WIDTH ? label : `${label.slice(0, AXIS_WIDTH - 2)}…`;
  return { text: fitted.padStart(AXIS_WIDTH - 1) + " ", style: { fg: THEME.muted } };
}
/** The call numbers, and when any call has a problem a second row with a
 *  ✖ under each one that does. A separate row, so a two-digit number never
 *  squeezes the mark out of a narrow column. A request that failed before
 *  the provider answered has no number; its tick is the ✖ itself. */
function ticks(calls: OverviewCall[], layout: ChartLayout): Painted[] {
  const numbers: Piece[] = [{ text: " ".repeat(AXIS_WIDTH) }];
  const marks: Piece[] = [{ text: " ".repeat(AXIS_WIDTH) }];
  calls.forEach((call) => {
    const selected = call.id === layout.selectedId;
    const failed = call.round === undefined;
    numbers.push(
      {
        text: (failed ? "✖" : String(call.round!.index + 1)).padEnd(layout.columnWidth),
        style: {
          fg: tickColor(call, selected, layout),
          ...(selected ? { bg: THEME.cursorBg, bold: true } : {}),
        },
      },
      { text: " " },
    );
    marks.push(
      {
        text: (!failed && call.errors.length > 0 ? "✖" : "").padEnd(layout.columnWidth),
        style: { fg: THEME.kind.error, ...(selected ? { bg: THEME.cursorBg } : {}) },
      },
      { text: " " },
    );
  });
  return [segment(numbers, layout.width), ...(layout.marks ? [segment(marks, layout.width)] : [])];
}
/** A failed request's tick is red. With several threads, a call's tick
 *  takes its thread's color; otherwise the selected call's is the accent. */
function tickColor(call: OverviewCall, selected: boolean, layout: ChartLayout): string {
  if (call.round === undefined) {
    return THEME.kind.error;
  }
  const thread = layout.threads.indexOf(call.threadName);
  if (layout.threads.length > 1 && thread !== -1) {
    return threadColor(thread);
  }
  return selected ? THEME.accent : THEME.muted;
}
export function fmtCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.000001) return `$${value.toExponential(1)}`;
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  return fmtUsd(value);
}
const VERTICAL_EIGHTHS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];
function verticalColumn(value: number, max: number, height: number): string[] {
  const cells = max <= 0 ? 0 : Math.max(0, Math.min(height, (value / max) * height));
  const full = Math.floor(cells);
  const partial =
    VERTICAL_EIGHTHS[
      Math.min(VERTICAL_EIGHTHS.length - 1, Math.round((cells - full) * VERTICAL_EIGHTHS.length))
    ];
  const sliver = value > 0 && full === 0 && partial === "" ? "▁" : partial;
  const bottomUp = [
    ...Array.from({ length: full }, () => "█"),
    ...(sliver === "" ? [] : [sliver]),
  ].slice(0, height);
  return [
    ...Array.from({ length: Math.max(0, height - bottomUp.length) }, () => " "),
    ...bottomUp.reverse(),
  ];
}
