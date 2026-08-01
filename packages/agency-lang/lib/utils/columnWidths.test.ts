import { describe, expect, it } from "vitest";

import { resolveColumnWidths, type ColumnPlan } from "./columnWidths.js";

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
    expect(() => resolveColumnWidths([pct(50)], undefined, "std::ui/layout"))
      .toThrow(/std::ui\/layout.*percentage width/);
  });
});
