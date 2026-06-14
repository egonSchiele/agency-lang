import { describe, expect, test } from "vitest";
import {
  barCells,
  baselineColumn,
  dataRange,
  resolveColor,
  resolveKeys,
  stackSegments,
  validateChart,
} from "./barchart.js";
import { color } from "../../utils/termcolors.js";

describe("barCells", () => {
  test("scales magnitude to cells", () => {
    expect(barCells(50, 100, 20)).toBe(10);
    expect(barCells(82, 91, 20)).toBe(18);
  });
  test("uses absolute value and guards zero span", () => {
    expect(barCells(-50, 100, 20)).toBe(10);
    expect(barCells(5, 0, 20)).toBe(0);
  });
});

describe("baselineColumn", () => {
  test("is 0 when all data is non-negative", () => {
    expect(baselineColumn(0, 100, 20)).toBe(0);
  });
  test("places zero at the interior when data has negatives", () => {
    expect(baselineColumn(-50, 100, 30)).toBe(10);
  });
});

describe("dataRange", () => {
  test("stacked ranges over row sums and includes zero", () => {
    expect(dataRange([{ label: "a", values: [120, 80, 30] }], "stacked")).toEqual({ min: 0, max: 230 });
  });
  test("grouped ranges over individual values", () => {
    expect(dataRange([{ label: "a", values: [82, -41] }], "grouped")).toEqual({ min: -41, max: 82 });
  });
});

describe("stackSegments", () => {
  test("largest-remainder distribution sums exactly to total cells", () => {
    const segs = stackSegments([120, 80, 30], 230, 20);
    expect(segs).toEqual([10, 7, 3]);
    expect(segs.reduce((a, b) => a + b, 0)).toBe(20);
  });
});

describe("resolveKeys", () => {
  test("auto-assigns colors and symbols round-robin", () => {
    expect(resolveKeys([{ name: "a" }, { name: "b" }], "█")).toEqual([
      { name: "a", color: "blue", symbol: "█" },
      { name: "b", color: "green", symbol: "▓" },
    ]);
  });
  test("supplies one implicit key when none given", () => {
    expect(resolveKeys(null, "█")).toEqual([{ name: "", color: "blue", symbol: "█" }]);
  });
});

describe("resolveColor", () => {
  test("named color matches termcolors", () => {
    expect(resolveColor("blue")("x")).toBe(color.blue("x"));
  });
  test("empty name is identity", () => {
    expect(resolveColor("")("x")).toBe("x");
  });
});

describe("validateChart", () => {
  test("rejects values/keys length mismatch", () => {
    expect(() =>
      validateChart(
        [{ name: "a", color: "blue", symbol: "█" }],
        [{ label: "Q1", values: [1, 2] }],
        "grouped",
      ),
    ).toThrow(/Q1/);
  });
  test("rejects mixed-sign stacked bar", () => {
    expect(() =>
      validateChart(
        [
          { name: "a", color: "blue", symbol: "█" },
          { name: "b", color: "green", symbol: "▓" },
        ],
        [{ label: "Q1", values: [10, -5] }],
        "stacked",
      ),
    ).toThrow(/mixes positive and negative/);
  });
});
