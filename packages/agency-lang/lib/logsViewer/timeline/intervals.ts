// Interval arithmetic for the timeline views. Pure — no spans, no terminal.

export type Interval = { start: number; end: number };

/** `base` minus the UNION of `pieces` (pieces are clamped into `base`
 *  first, so a malformed log can never produce a negative residue).
 *  Powers self-time: a span's envelope minus its children's envelopes. */
export function subtract(base: Interval, pieces: Interval[]): Interval[] {
  const clamped = pieces
    .map((p) => ({ start: Math.max(p.start, base.start), end: Math.min(p.end, base.end) }))
    .filter((p) => p.end > p.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  let cursor = base.start;
  for (const piece of clamped) {
    if (piece.start > cursor) {
      out.push({ start: cursor, end: piece.start });
    }
    cursor = Math.max(cursor, piece.end);
  }
  if (cursor < base.end) {
    out.push({ start: cursor, end: base.end });
  }
  return out;
}

/** Fraction of each of `cells` equal slices of `window` that `intervals`
 *  occupy, each in [0, 1]. Overlapping intervals clamp at 1 — shade means
 *  busyness, never overlap count. A zero-width window degenerates to 1ms
 *  so the math stays finite (the drill-into-a-0ms-span case). */
export function coverage(intervals: Interval[], window: Interval, cells: number): number[] {
  const windowMs = Math.max(window.end - window.start, 1);
  const cellMs = windowMs / cells;
  const covered = new Array(cells).fill(0);
  for (const iv of intervals) {
    if (iv.end < window.start || iv.start > window.end) continue;
    const first = Math.max(0, Math.floor((iv.start - window.start) / cellMs));
    const last = Math.min(cells - 1, Math.floor((iv.end - window.start) / cellMs));
    for (let i = first; i <= last; i++) {
      const cellStart = window.start + i * cellMs;
      const overlap = Math.min(iv.end, cellStart + cellMs) - Math.max(iv.start, cellStart);
      covered[i] += Math.max(overlap, 0);
    }
  }
  return covered.map((ms) => Math.min(ms / cellMs, 1));
}

export function totalMs(intervals: Interval[]): number {
  return intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}
