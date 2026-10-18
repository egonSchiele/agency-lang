import { describe, expect, it } from "vitest";

import { barText, ceilingRow, columnWindow, stackedColumn } from "./charts.js";

describe("barText", () => {
  it("is always the asked width", () => {
    for (const fraction of [0, 0.01, 0.5, 1, 7]) {
      expect(barText(fraction, 12)).toHaveLength(12);
    }
  });

  it("draws a tiny share as a sliver", () => {
    expect(barText(0.001, 12).trim()).toBe("▏");
  });

  it("draws zero as empty", () => {
    expect(barText(0, 12).trim()).toBe("");
  });
});

describe("stackedColumn", () => {
  it("rounds the stack, not each band: two small bands earn one row between them", () => {
    // Call 15 of a long-context trace: 11.5k fresh and 12.4k output against a
    // 116k scale on four rows. Separately both round to nothing.
    const cells = stackedColumn([0, 11_464, 12_436], 116_220, 4);
    expect(cells).toEqual([-1, -1, -1, 2]);
  });

  it("stacks bands from the bottom in the order given", () => {
    expect(stackedColumn([50, 30, 20], 100, 10)).toEqual([2, 2, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it("draws a non-zero column as at least one cell", () => {
    expect(stackedColumn([1, 0, 0], 100_000, 10)[9]).toBe(0);
  });

  it("does not overflow when rounded band heights exceed the chart", () => {
    expect(stackedColumn([34, 33, 33], 100, 3)).toHaveLength(3);
  });
});

describe("columnWindow", () => {
  it("shows every column when they fit", () => {
    expect(columnWindow(10, 40, undefined)).toEqual({ from: 0, to: 10 });
  });

  it("pins to the latest columns when nothing is focused", () => {
    expect(columnWindow(100, 40, undefined)).toEqual({ from: 60, to: 100 });
  });

  it("moves to include the focused column", () => {
    const shown = columnWindow(100, 40, 5);
    expect(shown.from).toBeLessThanOrEqual(5);
    expect(shown.to - shown.from).toBe(40);
  });
});

describe("ceilingRow", () => {
  it("places the maximum at the top and zero at the bottom", () => {
    expect(ceilingRow(100, 100, 10)).toBe(0);
    expect(ceilingRow(0, 100, 10)).toBe(9);
  });

  it("omits a ceiling above the chart", () => {
    expect(ceilingRow(101, 100, 10)).toBeUndefined();
  });
});
