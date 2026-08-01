// Components shared by the three bar views (flame, by-name, occurrences):
// the bar itself, the axis, the header line, the selection footer, and the
// width budget. One implementation of shading and layout, used three times.
import { fmtDuration } from "../spanText.js";
import { coverage, type Interval } from "../timeline/intervals.js";

/** Width budget. The bar-cell count is an input to `coverage`, so these
 *  are rendering math, not cosmetics. Degradation on narrow terminals:
 *  gutter shrinks first (floor 20), then stats (floor 8); the bar never
 *  drops below minBarCells. */
export const LAYOUT = {
  flameGutter: 48,
  byNameGutter: 28,
  occurrenceGutterMax: 64,
  occurrenceGutterShare: 0.55,
  flameStats: 16,
  byNameStats: 20,
  minBarCells: 10,
};

export type WidthSplit = { gutter: number; bar: number; stats: number };

export function splitWidth(view: "flame" | "byName" | "occurrences", cols: number): WidthSplit {
  let gutter: number;
  if (view === "flame") {
    gutter = LAYOUT.flameGutter;
  } else if (view === "byName") {
    gutter = LAYOUT.byNameGutter;
  } else {
    gutter = Math.min(LAYOUT.occurrenceGutterMax, Math.floor(cols * LAYOUT.occurrenceGutterShare));
  }
  let stats = view === "byName" ? LAYOUT.byNameStats : LAYOUT.flameStats;
  let bar = cols - gutter - stats;
  if (bar < LAYOUT.minBarCells) {
    gutter = Math.max(20, cols - stats - LAYOUT.minBarCells);
    bar = cols - gutter - stats;
  }
  if (bar < LAYOUT.minBarCells) {
    stats = Math.max(8, cols - gutter - LAYOUT.minBarCells);
    bar = Math.max(LAYOUT.minBarCells, cols - gutter - stats);
  }
  // The floors sum to 38; below that, keep the one-row invariant anyway —
  // a sub-floor bar beats a wrapped row (which desyncs the repaint math).
  if (gutter + bar + stats > cols) {
    bar = Math.max(1, cols - gutter - stats);
    if (gutter + bar + stats > cols) {
      stats = Math.max(0, cols - gutter - bar);
      gutter = Math.min(gutter, Math.max(0, cols - bar - stats));
    }
  }
  return { gutter, bar, stats };
}

/** Shaded cells for a set of intervals. The glyph is the fraction of the
 *  cell's time slice the intervals occupy — busyness, never overlap count:
 *  · none, ░ ≤25%, ▒ ≤50%, ▓ ≤90%, █ above. Floor override: any interval
 *  inside the window paints at least one ░ (losing a 60ms call on a
 *  20-minute axis is worse than overstating it). A running bar extends to
 *  the window end and is capped with ⋯ so it cannot read as finished. */
export class BarComponent {
  constructor(
    private readonly intervals: Interval[],
    private readonly opts: { running?: boolean },
  ) {}

  computeCells(window: Interval, cells: number): string {
    const draw = [...this.intervals];
    if (this.opts.running) {
      const lastEnd = draw.length > 0 ? Math.max(...draw.map((iv) => iv.end)) : window.start;
      if (window.end > lastEnd) {
        draw.push({ start: lastEnd, end: window.end });
      }
    }
    const fractions = coverage(draw, window, cells);
    const glyphs = fractions.map(glyphFor);
    for (const iv of draw) {
      if (iv.end < window.start || iv.start > window.end) continue;
      const windowMs = Math.max(window.end - window.start, 1);
      const at = Math.min(cells - 1, Math.max(0,
        Math.floor(((iv.start - window.start) / windowMs) * cells)));
      if (glyphs[at] === "·") {
        glyphs[at] = "░";
      }
    }
    if (this.opts.running && cells > 0) {
      glyphs[cells - 1] = "⋯";
    }
    return glyphs.join("");
  }
}

function glyphFor(fraction: number): string {
  if (fraction <= 0) return "·";
  if (fraction <= 0.25) return "░";
  if (fraction <= 0.5) return "▒";
  if (fraction <= 0.9) return "▓";
  return "█";
}

/** Tick labels over the bar area: left / mid / right offsets from the
 *  view start, padded to exactly the bar width. */
export class AxisHeader {
  constructor(private readonly gutter: number) {}

  computeText(window: Interval, viewStart: number, barCells: number): string {
    const left = fmtOffset(window.start - viewStart);
    const mid = fmtOffset((window.start + window.end) / 2 - viewStart);
    const right = fmtOffset(window.end - viewStart);
    const half = Math.floor(barCells / 2);
    const axis = padCell(left, half)
      + padCell(mid, Math.max(0, barCells - half - right.length))
      + right;
    return " ".repeat(this.gutter) + clipCell(axis, barCells).padEnd(barCells);
  }
}

export class TimelineHeader {
  computeText(args: {
    view: string;
    title: string;
    crumbs: string[];
    totalMs: number;
    zoom?: Interval;
    viewStart: number;
    adminShown: boolean;
    following?: boolean;
  }): string {
    const crumbs = args.crumbs.length > 0 ? `  » ${args.crumbs.join(" » ")}` : "";
    const admin = (args.adminShown ? "  [admin spans shown]" : "")
      + (args.following ? "  [following]" : "");
    const zoom = args.zoom !== undefined
      ? `  (zoom ${fmtOffset(args.zoom.start - args.viewStart)}–${fmtOffset(args.zoom.end - args.viewStart)})`
      : "";
    return `TIMELINE [${args.view}]  ${args.title}${crumbs}  ${fmtOffset(args.totalMs)}${admin}${zoom}`;
  }
}

/** Footers render identically across the bar views: one bright line. */
export class SelectionFooter {
  computeText(text: string): string {
    return text;
  }
}

/** Offsets and durations in the timeline read `15m59s` past a minute
 *  (fmtDuration's minutes style); `0ms`, not `?`, for zero. */
export function fmtOffset(ms: number): string {
  if (ms === 0) return "0ms";
  return fmtDuration(ms, { minutes: true });
}

/** The bottom hint line with the current view's name pinned to the
 *  bottom-right corner — every view (explorer included) renders through
 *  this so "where am I" is always answered in the same place. */
export function bottomHints(hints: string, tag: string, cols: number): string {
  const label = `[${tag}]`;
  const room = Math.max(0, cols - label.length - 1);
  const left = hints.length > room ? hints.slice(0, Math.max(0, room - 1)) + "…" : hints;
  return left + " ".repeat(Math.max(1, cols - left.length - label.length)) + label;
}

export function padCell(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function clipCell(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}
