import { describe, expect, it } from "vitest";

import { fitColumnWidths, resolveColumnWidths, type ColumnPlan } from "./columnWidths.js";

function cells(value: number): ColumnPlan {
  return { index: 0, parsed: { kind: "cells", value }, natural: 0, minWidth: 0 };
}

function pct(value: number): ColumnPlan {
  return { index: 0, parsed: { kind: "percent", value }, natural: 0, minWidth: 0 };
}

function natural(width: number): ColumnPlan {
  return { index: 0, parsed: null, natural: width, minWidth: 0 };
}

function full(): ColumnPlan {
  return { index: 0, parsed: { kind: "full" }, natural: 0, minWidth: 0 };
}

describe("resolveColumnWidths", () => {
  it("fixed columns claim their declared value; unsized claim natural width", () => {
    expect(resolveColumnWidths([cells(10), natural(7)], 80)).toEqual([10, 7]);
  });

  it("percent columns share the remainder after fixed claims", () => {
    expect(resolveColumnWidths([cells(20), pct(50), pct(50)], 60)).toEqual([20, 20, 20]);
  });

  it("percent sums over 100 divide the remainder proportionally", () => {
    expect(resolveColumnWidths([pct(150), pct(50)], 40)).toEqual([30, 10]);
  });

  it("full acts as 100 percent of the remainder", () => {
    expect(resolveColumnWidths([cells(30), full()], 80)).toEqual([30, 50]);
  });

  it("minWidth floors every column, including natural ones", () => {
    const plan: ColumnPlan[] = [{ index: 0, parsed: null, natural: 3, minWidth: 8 }];
    expect(resolveColumnWidths(plan, undefined)).toEqual([8]);
  });

  it("percent with no available width throws the basis error with the given context", () => {
    expect(() => resolveColumnWidths([pct(50)], undefined, "std::ui/layout")).toThrow(
      /std::ui\/layout.*percentage width/,
    );
  });
});

describe("fitColumnWidths", () => {
  function natAt(index: number, width: number): ColumnPlan {
    return { index, parsed: null, natural: width, minWidth: 0 };
  }
  function cellsAt(index: number, value: number): ColumnPlan {
    return { index, parsed: { kind: "cells", value }, natural: 0, minWidth: 0 };
  }

  it("leaves widths alone when they already fit", () => {
    expect(fitColumnWidths([10, 20], [natAt(0, 10), natAt(1, 20)], 40)).toEqual([10, 20]);
  });

  it("shrinks only the widest column when that is enough", () => {
    expect(fitColumnWidths([11, 150], [natAt(0, 11), natAt(1, 150)], 73)).toEqual([11, 62]);
  });

  it("gives an odd leftover cell to the leftmost shrunk column", () => {
    expect(fitColumnWidths([30, 30], [natAt(0, 30), natAt(1, 30)], 41)).toEqual([21, 20]);
  });

  it("never shrinks a fixed-width column", () => {
    expect(fitColumnWidths([30, 200], [cellsAt(0, 30), natAt(1, 200)], 33)).toEqual([30, 3]);
  });

  it("returns the floors when even they do not fit", () => {
    // The fixed column alone is wider than 33, so the other drops to its floor.
    expect(fitColumnWidths([50, 200], [cellsAt(0, 50), natAt(1, 200)], 33)).toEqual([50, 1]);
  });

  it("starts from the available width, so one huge cell stays fast", () => {
    // Starting from the widest cell would step down a billion times.
    const widths = fitColumnWidths([1_000_000_000, 5], [natAt(0, 1_000_000_000), natAt(1, 5)], 40);
    expect(widths).toEqual([35, 5]);
  });

  it("never shrinks a column below its minWidth", () => {
    const plan: ColumnPlan[] = [
      { index: 0, parsed: null, natural: 60, minWidth: 60 },
      natAt(1, 100),
    ];
    expect(fitColumnWidths([60, 100], plan, 70)).toEqual([60, 10]);
  });
});
