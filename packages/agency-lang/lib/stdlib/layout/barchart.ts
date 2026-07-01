// std::ui/layout — horizontal bar chart renderer for std::ui/chart.
//
// Value→cell scaling and the largest-remainder rounding in
// `stackSegments` (so stacked segments sum exactly to the bar length)
// are adapted from chartscii (MIT, https://github.com/tool3/chartscii).
import { color } from "../../utils/termcolors.js";
import { Block, above, beside, pad } from "./block.js";
import { visualWidth } from "./ansi.js";
import { LayoutNode } from "./nodes.js";
import { NodeHandler, SizingContext, resolveOwnWidth, setAttr } from "./sizing.js";

export type BarKey = { name: string; color?: string; symbol?: string };
export type Bar = { label: string; values: number[] };
export type BarMode = "stacked" | "grouped";

export type ResolvedKey = { name: string; color: string; symbol: string };

export const DEFAULT_COLORS = ["blue", "green", "brightYellow", "magenta", "cyan", "red"];
export const DEFAULT_SYMBOLS = ["█", "▓", "▒", "░"];
const DEFAULT_BAR_AREA = 40;
const TRACK_CHAR = "·";

// True only for a non-empty string. Used to decide whether an optional
// key field was explicitly set. The Agency block builder leaves omitted
// optional params as a runtime sentinel (not "" or undefined), so we
// can't trust `?? default` / truthiness on the raw value — only a real
// string counts as an explicit color/symbol; everything else auto-assigns.
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function resolveColor(name: unknown): (s: string) => string {
  if (!isNonEmptyString(name)) return (s) => s;
  if (name.startsWith("#")) return (s) => (color as any).hex(name)(s);
  const fn = (color as any)[name];
  return typeof fn === "function" ? (s) => fn(s) : (s) => s;
}

export function resolveKeys(keys: BarKey[] | null, barChar: string): ResolvedKey[] {
  const list = keys && keys.length > 0 ? keys : [{ name: "" } as BarKey];
  return list.map((k, i) => ({
    name: isNonEmptyString(k.name) ? k.name : "",
    color: isNonEmptyString(k.color) ? k.color : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    symbol: isNonEmptyString(k.symbol) ? k.symbol : (i === 0 ? barChar : DEFAULT_SYMBOLS[i % DEFAULT_SYMBOLS.length]),
  }));
}

export function dataRange(data: Bar[], mode: BarMode): { min: number; max: number } {
  const quantities =
    mode === "stacked"
      ? data.map((b) => b.values.reduce((a, c) => a + c, 0))
      : data.flatMap((b) => b.values);
  let min = 0;
  let max = 0;
  for (const q of quantities) {
    if (q < min) min = q;
    if (q > max) max = q;
  }
  return { min, max };
}

export function barCells(value: number, rangeSpan: number, barArea: number): number {
  if (rangeSpan <= 0) return 0;
  return Math.round((Math.abs(value) / rangeSpan) * barArea);
}

export function baselineColumn(rangeMin: number, rangeMax: number, barArea: number): number {
  const span = rangeMax - rangeMin;
  if (rangeMin >= 0 || span <= 0) return 0;
  return Math.round(((0 - rangeMin) / span) * barArea);
}

export function stackSegments(values: number[], rangeSpan: number, barArea: number): number[] {
  const total = values.reduce((a, b) => a + Math.abs(b), 0);
  const totalCells = barCells(total, rangeSpan, barArea);
  if (total <= 0 || totalCells <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.abs(v) / total) * totalCells);
  const result = raw.map((x) => Math.floor(x));
  let remaining = totalCells - result.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remaining > 0; k++) {
    result[order[k].i] += 1;
    remaining--;
  }
  return result;
}

export function validateChart(keys: ResolvedKey[], data: Bar[], mode: BarMode): void {
  const expected = keys.length;
  for (const bar of data) {
    if (bar.values.length !== expected) {
      throw new Error(
        `std::ui/chart: bar "${bar.label}" has ${bar.values.length} value(s) but there are ${expected} key(s).`,
      );
    }
    for (const v of bar.values) {
      if (!Number.isFinite(v)) {
        throw new Error(`std::ui/chart: bar "${bar.label}" has a non-finite value.`);
      }
    }
    if (mode === "stacked") {
      const hasPos = bar.values.some((v) => v > 0);
      const hasNeg = bar.values.some((v) => v < 0);
      if (hasPos && hasNeg) {
        throw new Error(
          `std::ui/chart: stacked bar "${bar.label}" mixes positive and negative values; uniform sign required.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtValue(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function track(n: number): string {
  return n > 0 ? color.dim(TRACK_CHAR.repeat(n)) : "";
}

function drawBar(
  cells: number,
  baseline: number,
  barArea: number,
  sign: number,
  fill: string,
  colorFn: (s: string) => string,
): string {
  if (sign >= 0) {
    const c = Math.min(cells, barArea - baseline);
    return track(baseline) + colorFn(fill.repeat(c)) + track(barArea - baseline - c);
  }
  const c = Math.min(cells, baseline);
  return track(baseline - c) + colorFn(fill.repeat(c)) + track(barArea - baseline);
}

function drawStack(
  segs: number[],
  keys: ResolvedKey[],
  baseline: number,
  barArea: number,
  sign: number,
): string {
  // Clamp the cumulative run to the width available on this side of the
  // baseline, so a stack whose total exceeds the axis maximum saturates
  // the bar instead of overflowing the chart.
  const avail = sign >= 0 ? barArea - baseline : baseline;
  let used = 0;
  const clamped = segs.map((n) => {
    const c = Math.max(0, Math.min(n, avail - used));
    used += c;
    return c;
  });
  const total = clamped.reduce((a, b) => a + b, 0);
  const body = clamped.map((n, i) => resolveColor(keys[i].color)(keys[i].symbol.repeat(n))).join("");
  if (sign >= 0) {
    return track(baseline) + body + track(barArea - baseline - total);
  }
  return track(baseline - total) + body + track(barArea - baseline);
}

type ChartRow = { label: string; bar: string; value: string };

// The value shown beside a bar: in stacked mode the category total; in
// grouped mode each key's own value (one per bar).
function barValue(bar: Bar, mode: BarMode, ki: number): string {
  return mode === "stacked"
    ? fmtValue(bar.values.reduce((s, v) => s + v, 0))
    : fmtValue(bar.values[ki]);
}

// "What" each data entry becomes: in grouped mode one row per key (label
// on the first, its own value on each); in stacked mode a single row. No
// padding or layout concerns here.
function chartRows(
  data: Bar[],
  keys: ResolvedKey[],
  mode: BarMode,
  span: number,
  barArea: number,
  baseline: number,
): ChartRow[] {
  return data.flatMap((bar) => {
    if (mode === "stacked") {
      const sign = bar.values.some((v) => v < 0) ? -1 : 1;
      const segs = stackSegments(bar.values, span, barArea);
      return [{ label: bar.label, bar: drawStack(segs, keys, baseline, barArea, sign), value: barValue(bar, "stacked", 0) }];
    }
    return keys.map((k, ki) => {
      const v = bar.values[ki];
      const bar_ = drawBar(barCells(v, span, barArea), baseline, barArea, Math.sign(v) || 1, k.symbol, resolveColor(k.color));
      return { label: ki === 0 ? bar.label : "", bar: bar_, value: barValue(bar, "grouped", ki) };
    });
  });
}

// Stack non-empty blocks vertically. Used for title / legend / body.
function stackBlocks(blocks: Block[]): Block {
  return blocks
    .filter((b) => b.height > 0)
    .reduce((acc, b) => (acc.height === 0 ? b : above(acc, b)), Block.empty());
}

export function renderBarChart(node: LayoutNode): Block {
  const a = node.attrs as any;
  const mode: BarMode = a.mode === "stacked" ? "stacked" : "grouped";
  const data: Bar[] = Array.isArray(a.data) ? a.data : [];
  const keys = resolveKeys(
    Array.isArray(a.keys) ? a.keys : null,
    typeof a.barChar === "string" && a.barChar ? a.barChar : "█",
  );
  validateChart(keys, data, mode);

  const showValues: boolean = a.showValues !== false;
  const wantLegend: boolean = a.legend !== false;
  const resolvedWidth: number | undefined = typeof a.resolvedWidth === "number" ? a.resolvedWidth : undefined;

  if (typeof a.max === "number" && (!Number.isFinite(a.max) || a.max < 0)) {
    throw new Error(`std::ui/chart: max must be a non-negative number, got ${a.max}.`);
  }

  // Value shown per row (grouped → one per key; stacked → category total).
  const allValues = data.flatMap((bar) =>
    mode === "stacked"
      ? [barValue(bar, "stacked", 0)]
      : keys.map((_k, ki) => barValue(bar, "grouped", ki)),
  );
  const labelW = data.length ? Math.max(...data.map((b) => visualWidth(b.label))) : 0;
  const valueW = showValues ? Math.max(0, ...allValues.map((s) => s.length)) : 0;

  const chrome = labelW + 1 + (showValues ? valueW + 1 : 0);
  const totalW = resolvedWidth ?? chrome + DEFAULT_BAR_AREA;
  // Clamp to 0 (not 1) so an explicit `width` is never exceeded; a chart
  // with no room left simply renders an empty bar region.
  const barArea = Math.max(0, totalW - chrome);

  const { min, max: autoMax } = dataRange(data, mode);
  // A positive `max` fixes the axis maximum (values beyond it saturate);
  // 0 / unset derives it from the data.
  const max = typeof a.max === "number" && a.max > 0 ? a.max : autoMax;
  const span = max - min;
  const baseline = baselineColumn(min, max, barArea);

  const rows = chartRows(data, keys, mode, span, barArea, baseline);

  // "How" — three aligned columns combined with the Block algebra, the
  // same pad/beside/above approach composeRow and composeTable use. No
  // hand-rolled padding or string concatenation.
  const gap = Block.of(rows.map(() => " "));
  const labelCol = pad(Block.of(rows.map((r) => r.label)), labelW, rows.length, "start", "start");
  const barCol = Block.of(rows.map((r) => r.bar));
  const valueCol = pad(Block.of(rows.map((r) => r.value)), valueW, rows.length, "end", "start");

  const body = showValues
    ? beside(beside(beside(beside(labelCol, gap), barCol), gap), valueCol)
    : beside(beside(labelCol, gap), barCol);

  const title = typeof a.title === "string" && a.title ? Block.of(a.title) : Block.empty();
  const legend =
    wantLegend && keys.some((k) => k.name)
      ? Block.of(keys.map((k) => resolveColor(k.color)(k.symbol) + " " + k.name).join("  "))
      : Block.empty();

  return stackBlocks([title, legend, body]);
}

export function sizeBarChart(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  if (own === undefined) return node; // unsized: render falls back to DEFAULT_BAR_AREA
  return setAttr(node, "resolvedWidth", own);
}

export const barchart: NodeHandler = { size: sizeBarChart, render: renderBarChart };
