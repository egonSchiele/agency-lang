// Is it getting better: one row per agent, buckets across the table's
// date range, each bucket the mean score of that agent's graded runs in
// it, drawn as a height glyph colored by verdict. The bucket span is
// derived from the viewport: start at a day (or a week for long
// ranges), then coarsen until every bucket fits — a multi-year range
// must never overflow the terminal.
import { column, line, row as tuiRow } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import { agentColors } from "../identity.js";
import type { RunRow } from "../rows.js";
import { EMPTY_CELL, scoreColor } from "./rowFormat.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

export const TREND_GLYPHS = "▁▂▃▄▅▆▇";
const EMPTY_BUCKET = "·";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const AGENT_COL_WIDTH = 20;
const LATEST_COL_WIDTH = 12;
const CHROME_ROWS = 4;
const HINTS = "t/T views  Esc back  q quit";

export type TrendBuckets = { startMs: number; bucketMs: number; count: number };

/** Buckets spanning [minMs, maxMs]: day baseline, week when a day
 *  cannot fit, then repeated doubling until `count <= maxBuckets`. */
export function trendBuckets(minMs: number, maxMs: number, maxBuckets: number): TrendBuckets {
  const span = Math.max(1, maxMs - minMs + 1);
  let bucketMs = span <= maxBuckets * DAY_MS ? DAY_MS : WEEK_MS;
  while (Math.ceil(span / bucketMs) > maxBuckets) {
    bucketMs *= 2;
  }
  return { startMs: minMs, bucketMs, count: Math.ceil(span / bucketMs) };
}

export class TrendView implements ExplorerView {
  readonly viewName = "trend" as const;
  private rows: RunRow[] = [];
  private colors: Record<string, string | undefined> = Object.create(null);
  private message = "";

  setData(rows: RunRow[]): void {
    this.rows = rows;
    this.colors = agentColors(rows.map((row) => row.agent));
  }

  setProgress(): void {
    // The runs table narrates loading.
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return [
      `Bucket glyphs ${TREND_GLYPHS} = mean score in that day/week; ${EMPTY_BUCKET} = no graded runs.`,
      "The right column is the latest mean and its change vs the previous bucket.",
      "t/T switch view    Esc back to the runs table    q quit",
    ];
  }

  handleKey(event: KeyEvent): ExplorerAction {
    const key = formatKey(event);
    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    if (key === "t") {
      return { kind: "cycleView", delta: 1 };
    }
    if (key === "T") {
      return { kind: "cycleView", delta: -1 };
    }
    if (key === "Escape" || key === "Left" || key === "h") {
      return { kind: "back" };
    }
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const dated = this.rows.filter((row) => row.startedAtMs !== null);
    const maxBuckets = Math.max(4, viewport.cols - AGENT_COL_WIDTH - LATEST_COL_WIDTH - 2);
    const agents = [...new Set(this.rows.map((row) => row.agent))];
    const bucketsSpec =
      dated.length === 0
        ? null
        : trendBuckets(
            Math.min(...dated.map((row) => row.startedAtMs ?? 0)),
            Math.max(...dated.map((row) => row.startedAtMs ?? 0)),
            maxBuckets,
          );

    const agentRows = agents
      .slice(0, Math.max(1, viewport.rows - CHROME_ROWS))
      .map((agent) => this.agentRow(agent, bucketsSpec));

    return column(
      { justifyContent: "flex-start" },
      line("TREND  score over time, one row per agent", { height: 1, fg: "bright-white" }),
      ...agentRows,
      line(this.message, { height: 1, fg: "gray" }),
      line(bottomHints(HINTS, this.viewName, viewport.cols), { height: 1, fg: "gray" }),
    );
  }

  private agentRow(agent: string, spec: TrendBuckets | null): Element {
    const label = clip(agent, AGENT_COL_WIDTH - 1);
    const labelSegment = line(label.padEnd(AGENT_COL_WIDTH), {
      width: AGENT_COL_WIDTH,
      height: 1,
      fg: this.colors[agent],
    });
    if (spec === null) {
      return tuiRow({ height: 1 }, labelSegment, line(EMPTY_CELL, { height: 1, fg: "gray" }));
    }

    const means = this.bucketMeans(agent, spec);
    const bucketSegments = means.map((mean) => {
      if (mean === null) {
        return line(EMPTY_BUCKET, { width: 1, height: 1, fg: "gray" });
      }
      return line(glyphFor(mean), { width: 1, height: 1, fg: scoreColor(mean) });
    });
    return tuiRow({ height: 1 }, labelSegment, ...bucketSegments, this.latestSegment(means));
  }

  private bucketMeans(agent: string, spec: TrendBuckets): (number | null)[] {
    const means: (number | null)[] = [];
    for (let bucket = 0; bucket < spec.count; bucket++) {
      const from = spec.startMs + bucket * spec.bucketMs;
      const to = from + spec.bucketMs;
      const graded = this.rows.filter(
        (row) =>
          row.agent === agent &&
          row.score !== null &&
          row.startedAtMs !== null &&
          row.startedAtMs >= from &&
          row.startedAtMs < to,
      );
      means.push(
        graded.length === 0
          ? null
          : graded.reduce((sum, row) => sum + (row.score ?? 0), 0) / graded.length,
      );
    }
    return means;
  }

  private latestSegment(means: (number | null)[]): Element {
    const scored = means.filter((mean): mean is number => mean !== null);
    if (scored.length === 0) {
      return line(`  ${EMPTY_CELL}`.padEnd(LATEST_COL_WIDTH), {
        width: LATEST_COL_WIDTH,
        height: 1,
        fg: "gray",
      });
    }
    const latest = scored[scored.length - 1];
    const previous = scored.length > 1 ? scored[scored.length - 2] : null;
    const delta =
      previous === null
        ? ""
        : `${latest >= previous ? "▲" : "▼"}${Math.abs(latest - previous).toFixed(2)}`;
    const text = ` ${latest.toFixed(2)} ${delta}`;
    return line(clip(text, LATEST_COL_WIDTH).padEnd(LATEST_COL_WIDTH), {
      width: LATEST_COL_WIDTH,
      height: 1,
      fg: scoreColor(latest),
    });
  }
}

function glyphFor(mean: number): string {
  const clamped = Math.max(0, Math.min(1, mean));
  const index = Math.min(TREND_GLYPHS.length - 1, Math.floor(clamped * TREND_GLYPHS.length));
  return TREND_GLYPHS[index];
}

function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}
