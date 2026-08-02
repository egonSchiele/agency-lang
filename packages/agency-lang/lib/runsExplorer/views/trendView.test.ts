import { describe, expect, it } from "vitest";

import { TrendView, TREND_GLYPHS, trendBuckets } from "./trendView.js";
import { runRow, screenText } from "./viewTestUtils.js";

const DAY = 24 * 60 * 60 * 1000;
const viewport = { rows: 24, cols: 100 };

function series() {
  return [
    runRow("r1", { agent: "agent-a", startedAtMs: 0 * DAY, score: 0.0 }),
    runRow("r2", { agent: "agent-a", startedAtMs: 2 * DAY, score: 0.5 }),
    runRow("r3", { agent: "agent-a", startedAtMs: 4 * DAY, score: 1.0 }),
    runRow("r4", { agent: "agent-b", startedAtMs: 4 * DAY, score: null }),
  ];
}

describe("trendBuckets", () => {
  it("uses day buckets for short ranges and coarsens until the viewport fits", () => {
    const short = trendBuckets(0, 9 * DAY, 40);
    expect(short.bucketMs).toBe(DAY);
    expect(short.count).toBe(10);

    const multiYear = trendBuckets(0, 900 * DAY, 40);
    expect(multiYear.count).toBeLessThanOrEqual(40);
    expect(multiYear.bucketMs).toBeGreaterThan(7 * DAY);
  });
});

describe("TrendView", () => {
  it("renders one row per agent with glyphs for scored buckets and dots for empty ones", () => {
    const view = new TrendView();
    view.setData(series());
    const text = screenText(view.render(viewport));
    const agentRow = text.split("\n").find((line) => line.includes("agent-a"));
    expect(agentRow).toBeDefined();
    expect(agentRow).toContain(TREND_GLYPHS[0]);
    expect(agentRow).toContain(TREND_GLYPHS[TREND_GLYPHS.length - 1]);
    expect(agentRow).toContain("·");
  });

  it("objective zero is a real (lowest) glyph, not an empty bucket", () => {
    const view = new TrendView();
    view.setData([runRow("z", { agent: "agent-z", startedAtMs: 0, score: 0 })]);
    const text = screenText(view.render(viewport));
    const row = text.split("\n").find((line) => line.includes("agent-z"));
    expect(row).toContain(TREND_GLYPHS[0]);
  });

  it("the latest column shows the last mean and the delta vs the previous non-empty bucket", () => {
    const view = new TrendView();
    view.setData(series());
    const text = screenText(view.render(viewport));
    const agentRow = text.split("\n").find((line) => line.includes("agent-a"));
    expect(agentRow).toContain("1.00");
    expect(agentRow).toContain("▲0.50");
  });

  it("an all-ungraded agent renders a dim placeholder row", () => {
    const view = new TrendView();
    view.setData(series());
    const text = screenText(view.render(viewport));
    const bRow = text.split("\n").find((line) => line.includes("agent-b"));
    expect(bRow).toContain("—");
  });

  it("a narrow viewport still renders without overflowing", () => {
    const view = new TrendView();
    view.setData(series());
    const narrow = screenText(view.render({ rows: 24, cols: 48 }));
    for (const line of narrow.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(48);
    }
  });

  it("keys mirror the other variant views", () => {
    const view = new TrendView();
    expect(view.handleKey({ key: "T" })).toEqual({ kind: "cycleView", delta: -1 });
    expect(view.handleKey({ key: "escape" })).toEqual({ kind: "back" });
    expect(view.handleKey({ key: "q" })).toEqual({ kind: "quit" });
  });
});
