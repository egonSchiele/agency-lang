import { describe, expect, test } from "vitest";
// Import through the public layout entry (not ./barchart.js directly) so the
// module graph initializes in the same order as production. Importing
// barchart.js first would evaluate it before render.js builds HANDLERS,
// leaving its handler entry undefined mid-cycle.
import { _internal, _render, LayoutNode } from "../layout.js";
import { color } from "../../utils/termcolors.js";

const {
  barCells,
  baselineColumn,
  dataRange,
  resolveColor,
  resolveKeys,
  stackSegments,
  validateChart,
} = _internal;

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

function chartNode(attrs: Record<string, unknown>): LayoutNode {
  return { type: "barchart", attrs, children: [] };
}

function renderPlain(attrs: Record<string, unknown>): string {
  // color: false → deterministic, ANSI stripped.
  return _render(chartNode(attrs), false);
}

describe("renderBarChart", () => {
  test("single-series bar fills proportionally and shows value + label", () => {
    const out = renderPlain({
      mode: "grouped",
      data: [
        { label: "North", values: [10] },
        { label: "South", values: [5] },
      ],
      barChar: "#",
      showValues: true,
      legend: false,
      // chrome = labelW(5) + 1 + valueW(2) + 1 = 9, so barArea = 9.
      // Asserts relative bar length + containment, not exact width.
      resolvedWidth: 18,
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("North");
    expect(lines[0]).toContain("10");
    const northBars = (lines[0].match(/#/g) ?? []).length;
    const southBars = (lines[1].match(/#/g) ?? []).length;
    expect(northBars).toBeGreaterThan(southBars);
  });

  test("legend lists each named key", () => {
    const out = renderPlain({
      mode: "stacked",
      keys: [{ name: "web" }, { name: "app" }],
      data: [{ label: "Q1", values: [3, 1] }],
      legend: true,
      showValues: false,
      resolvedWidth: 30,
    });
    expect(out).toContain("web");
    expect(out).toContain("app");
  });

  test("rejects mixed-sign stacked bars at render time", () => {
    expect(() =>
      renderPlain({
        mode: "stacked",
        keys: [{ name: "a" }, { name: "b" }],
        data: [{ label: "Q1", values: [5, -2] }],
      }),
    ).toThrow(/mixes positive and negative/);
  });
});
