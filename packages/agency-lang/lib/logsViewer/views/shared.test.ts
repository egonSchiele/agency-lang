import { describe, expect, it } from "vitest";

import {
  AxisHeader,
  BarComponent,
  TimelineHeader,
  clipCell,
  padCell,
  splitWidth,
} from "./shared.js";

const MIN20 = 20 * 60 * 1000;

describe("BarComponent", () => {
  const window = { start: 0, end: 100 };

  it("draws a full cell as █ and a partial one as the half it mostly occupies (cell = 25ms)", () => {
    const bar = (start: number, end: number) =>
      new BarComponent([{ start, end }], {}).computeCells(window, 4);
    expect(new BarComponent([], {}).computeCells(window, 4)).toBe("····");
    expect(bar(0, 24)[0]).toBe("█"); // 0.96 of the cell
    expect(bar(0, 19)[0]).toBe("█"); // 0.76: more than three quarters reads full
    expect(bar(0, 18)[0]).toBe("▌"); // 0.72: still the half it mostly occupies
    expect(bar(3, 22)[0]).toBe("█"); // 0.76, centred: not a half glyph
    expect(bar(0, 6)[0]).toBe("▌"); // ends early: the left side
    expect(bar(19, 25)[0]).toBe("▐"); // starts late: the right side
    // A span across cells: a start edge, full cells, an end edge.
    expect(bar(10, 60)).toBe("▐█▌·");
  });

  it("the floor: a 60ms call inside a 20-minute window still paints one cell", () => {
    const bigWindow = { start: 0, end: MIN20 };
    const cells = new BarComponent([{ start: 5_000, end: 5_060 }], {}).computeCells(bigWindow, 60);
    expect(cells).toContain("▌");
  });

  it("the floor glyph sits on the side of its cell the short call falls in", () => {
    const bigWindow = { start: 0, end: MIN20 };
    // Cells are 20s wide; a call at 19s is at the right end of the first cell.
    const cells = new BarComponent([{ start: 19_000, end: 19_060 }], {}).computeCells(
      bigWindow,
      60,
    );
    expect(cells.split("").filter((c) => c !== "·")).toEqual(["▐"]);
  });

  it("a zero-width span inside a wide window renders exactly one ▌", () => {
    const bigWindow = { start: 0, end: MIN20 };
    const cells = new BarComponent([{ start: 5, end: 5 }], {}).computeCells(bigWindow, 60);
    expect(cells.split("").filter((c) => c !== "·")).toEqual(["▌"]);
  });

  it("a running bar extends to the window end and caps with ⋯", () => {
    const cells = new BarComponent([{ start: 0, end: 30 }], { running: true }).computeCells(
      window,
      10,
    );
    expect(cells[cells.length - 1]).toBe("⋯");
    expect(cells).not.toContain("·");
  });

  it("output is always exactly `cells` plain characters — the one-row invariant", () => {
    for (const cells of [1, 7, 40, 133]) {
      const out = new BarComponent([{ start: 3, end: 55 }], {}).computeCells(window, cells);
      expect(out.length).toBe(cells);
      expect(out).not.toMatch(/\x1b/);
    }
  });
});

describe("splitWidth", () => {
  it("wide terminals get the nominal gutters", () => {
    const w = splitWidth("timeline", 200);
    expect(w.gutter).toBe(48);
    expect(w.stats).toBe(16);
    expect(w.bar).toBe(200 - 48 - 16);
  });

  it("narrow terminals shrink the gutter first, never the bar below its floor", () => {
    const w = splitWidth("timeline", 60);
    expect(w.bar).toBeGreaterThanOrEqual(10);
    expect(w.gutter).toBeGreaterThanOrEqual(20);
    expect(w.gutter + w.bar + w.stats).toBeLessThanOrEqual(60);
  });

  it("below that, the stats column gives way", () => {
    const w = splitWidth("occurrences", 44);
    expect(w.bar).toBeGreaterThanOrEqual(10);
    expect(w.stats).toBeGreaterThanOrEqual(8);
  });
});

describe("splitWidth degradation", () => {
  it("never returns a split wider than the terminal, all the way down", () => {
    for (const view of ["timeline", "occurrences"] as const) {
      for (let cols = 10; cols <= 200; cols += 7) {
        const w = splitWidth(view, cols);
        expect(w.gutter + w.bar + w.stats).toBeLessThanOrEqual(cols);
        expect(w.bar).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("AxisHeader", () => {
  it("pads the gutter then lays left/mid/right labels across the bar width", () => {
    const text = new AxisHeader(10).computeText({ start: 0, end: 120_000 }, 0, 40);
    expect(text.startsWith(" ".repeat(10))).toBe(true);
    expect(text).toContain("0ms");
    expect(text).toContain("1m00s");
    expect(text).toContain("2m00s");
    expect(text.length).toBe(10 + 40);
  });
});

describe("TimelineHeader", () => {
  it("carries elapsed time, crumbs, admin marker, and zoom range", () => {
    const text = new TimelineHeader().computeText({
      crumbs: ["codeAgent", "llm"],
      totalMs: 90_000,
      zoom: { start: 10_000, end: 20_000 },
      viewStart: 0,
      adminShown: true,
    });
    expect(text).toContain("Elapsed 1m30s");
    expect(text).toContain("» codeAgent » llm");
    expect(text).toContain("[admin spans shown]");
    expect(text).toContain("zoom 10.0s–20.0s");
  });
});

describe("cells", () => {
  it("padCell pads and clipCell clips with …", () => {
    expect(padCell("ab", 4)).toBe("ab  ");
    expect(clipCell("abcdef", 4)).toBe("abc…");
    expect(clipCell("ab", 4)).toBe("ab");
  });
});
