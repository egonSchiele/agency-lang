import { paint, segment, type Painted, type Piece } from "../../tui/paint.js";
import { fmtTokens, fmtUsd } from "../format.js";
import { fmtDuration } from "../spanText.js";
import { THEME } from "../theme.js";
import type { Round } from "../timeline/rounds.js";
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
};

export function overviewCharts(
  rounds: Round[],
  selectedId: string | undefined,
  width: number,
  height: number,
  ceiling: number | undefined,
): Painted[] {
  const available = Math.max(1, width - AXIS_WIDTH);
  const minSlot = Math.max(MIN_SLOT, String(rounds.length).length + 1);
  const room = overviewCallCapacity(rounds.length, width);
  const selectedAt = Math.max(
    0,
    rounds.findIndex((round) => round.id === selectedId),
  );
  const window = columnWindow(rounds.length, room, selectedAt);
  const shown = rounds.slice(window.from, window.to);
  const slot = Math.min(
    Math.max(MAX_SLOT, minSlot),
    Math.floor(available / Math.max(1, shown.length)),
  );
  const layout = {
    width,
    height: Math.max(0, Math.floor((height - CHROME_ROWS) / CHART_COUNT)),
    columnWidth: Math.max(1, slot - 1),
    selectedId,
  };
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
      values: shown.map((round) => round.costUsd),
    }),
    paint(""),
    ...metricChart(shown, layout, {
      title: "TIME PER LLM CALL",
      max: maxTime,
      label: fmtDuration(maxTime),
      color: THEME.kind.user,
      values: shown.map((round) => round.durationMs),
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
  rounds: Round[],
  layout: ChartLayout,
  max: number,
  ceiling: number | undefined,
): Painted[] {
  const columns = rounds.map((round) =>
    stackedColumn([round.cachedTokens, round.freshTokens, round.outputTokens], max, layout.height),
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
      pieces.push(columnPiece(glyph, colors[band] ?? THEME.chrome, rounds[index], layout), {
        text: " ",
      });
    });
    return segment(pieces, layout.width);
  });
  return [
    overviewSection("CONTEXT PER LLM CALL", layout.width),
    ...rows,
    ticks(rounds, layout),
    segment(
      [
        { text: "░ cached", style: { fg: THEME.cached } },
        { text: "  ▒ fresh", style: { fg: THEME.kind.user } },
        { text: "  █ output", style: { fg: THEME.kind.assistant } },
      ],
      layout.width,
    ),
  ];
}

function metricChart(rounds: Round[], layout: ChartLayout, chart: Chart): Painted[] {
  const columns = chart.values.map((value) => verticalColumn(value, chart.max, layout.height));
  const rows = Array.from({ length: layout.height }, (_, row) => {
    const pieces: Piece[] = [axis(row === 0 ? chart.label : row === layout.height - 1 ? "0" : "")];
    columns.forEach((cells, index) =>
      pieces.push(columnPiece(cells[row], chart.color, rounds[index], layout), { text: " " }),
    );
    return segment(pieces, layout.width);
  });
  return [overviewSection(chart.title, layout.width), ...rows, ticks(rounds, layout)];
}

function columnPiece(glyph: string, color: string, round: Round, layout: ChartLayout): Piece {
  return {
    text: glyph.repeat(layout.columnWidth),
    style: {
      fg: color,
      ...(round.id === layout.selectedId ? { bg: THEME.cursorBg, bold: true } : {}),
    },
  };
}
function axis(label: string): Piece {
  const fitted = label.length < AXIS_WIDTH ? label : `${label.slice(0, AXIS_WIDTH - 2)}…`;
  return { text: fitted.padStart(AXIS_WIDTH - 1) + " ", style: { fg: THEME.muted } };
}
function ticks(rounds: Round[], layout: ChartLayout): Painted {
  const pieces: Piece[] = [{ text: " ".repeat(AXIS_WIDTH) }];
  rounds.forEach((round) => {
    const selected = round.id === layout.selectedId;
    pieces.push(
      {
        text: String(round.index + 1).padEnd(layout.columnWidth),
        style: {
          fg: selected ? THEME.accent : THEME.muted,
          ...(selected ? { bg: THEME.cursorBg, bold: true } : {}),
        },
      },
      { text: " " },
    );
  });
  return segment(pieces, layout.width);
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
