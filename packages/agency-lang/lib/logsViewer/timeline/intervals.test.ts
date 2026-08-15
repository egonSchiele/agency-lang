import { describe, expect, it } from "vitest";

import { coverage, subtract, totalMs } from "./intervals.js";

describe("subtract", () => {
  it("removes a nested piece, leaving both sides", () => {
    expect(subtract({ start: 0, end: 100 }, [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("subtracts the UNION of overlapping pieces (parallel fork children)", () => {
    expect(
      subtract({ start: 0, end: 100 }, [
        { start: 10, end: 50 },
        { start: 30, end: 70 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 70, end: 100 },
    ]);
  });

  it("exact cover leaves nothing", () => {
    expect(subtract({ start: 5, end: 9 }, [{ start: 5, end: 9 }])).toEqual([]);
  });

  it("clamps pieces that extend past the base — malformed logs must not go negative", () => {
    const out = subtract({ start: 10, end: 20 }, [
      { start: 0, end: 15 },
      { start: 18, end: 99 },
    ]);
    expect(out).toEqual([{ start: 15, end: 18 }]);
    expect(totalMs(out)).toBe(3);
  });

  it("zero-width base yields no residue", () => {
    expect(subtract({ start: 7, end: 7 }, [])).toEqual([]);
  });

  it("subtract with no pieces returns the base (every leaf span path)", () => {
    expect(subtract({ start: 3, end: 9 }, [])).toEqual([{ start: 3, end: 9 }]);
  });
});

describe("coverage", () => {
  it("full-window interval covers every cell fully", () => {
    expect(coverage([{ start: 0, end: 100 }], { start: 0, end: 100 }, 4)).toEqual([1, 1, 1, 1]);
  });

  it("half-cell occupancy reports 0.5 for that cell", () => {
    expect(coverage([{ start: 0, end: 12.5 }], { start: 0, end: 100 }, 4)[0]).toBeCloseTo(0.5);
  });

  it("crosses cell boundaries with the right per-cell fractions", () => {
    expect(coverage([{ start: 20, end: 30 }], { start: 0, end: 100 }, 4)).toEqual([0.2, 0.2, 0, 0]);
  });

  it("two intervals in one cell clamp to 1 — shade is busyness, never overlap count", () => {
    const out = coverage(
      [
        { start: 0, end: 20 },
        { start: 5, end: 25 },
      ],
      { start: 0, end: 100 },
      4,
    );
    expect(out[0]).toBe(1);
  });

  it("intervals outside the window contribute nothing", () => {
    expect(coverage([{ start: 200, end: 300 }], { start: 0, end: 100 }, 4)).toEqual([0, 0, 0, 0]);
  });

  it("a zero-width window stays finite (visibility of tiny spans is the ░ floor's job)", () => {
    const out = coverage([{ start: 5, end: 5 }], { start: 5, end: 5 }, 4);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe("totalMs", () => {
  it("sums interval lengths", () => {
    expect(
      totalMs([
        { start: 0, end: 3 },
        { start: 10, end: 14 },
      ]),
    ).toBe(7);
  });
});
