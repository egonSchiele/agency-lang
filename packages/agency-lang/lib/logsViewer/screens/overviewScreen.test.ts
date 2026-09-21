import { describe, expect, it } from "vitest";

import type { Element } from "../../tui/elements.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { leaf, span, trace } from "../timeline/fixture.js";
import { OverviewScreen } from "./overviewScreen.js";

function fixture(threadLabel = "main") {
  return [
    trace([
      leaf("threadCreated", 0, { threadId: "1", label: threadLabel }),
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1_000, {
            model: '"m1"',
            threadId: "1",
            timeTaken: 100,
            usage: { inputTokens: 95, cachedInputTokens: 13_824, outputTokens: 190 },
            cost: { totalCost: 0.011 },
          }),
          leaf("promptCompletion", 3_000, {
            model: '"m1"',
            threadId: "1",
            timeTaken: 1_500,
            usage: { inputTokens: 200, cachedInputTokens: 12_000, outputTokens: 400 },
            cost: { totalCost: 0.025 },
          }),
          leaf("promptCompletion", 4_000, {
            model: '"m1"',
            threadId: "1",
            timeTaken: 200,
            usage: { inputTokens: 300, cachedInputTokens: 20_000, outputTokens: 500 },
            cost: { totalCost: 0.015 },
          }),
        ],
        { id: "L" },
      ),
      span(
        "toolExecution",
        [
          leaf("toolCallStart", 1_100, { toolName: "read" }),
          leaf("toolCall", 1_300, { toolName: "read" }),
        ],
        { id: "tool-1" },
      ),
      span(
        "toolExecution",
        [
          leaf("toolCallStart", 3_100, { toolName: "write" }),
          leaf("toolCall", 3_300, { toolName: "write" }),
        ],
        { id: "tool-2" },
      ),
    ]),
  ];
}

function flat(element: Element): string[] {
  if (element.type === "text") {
    return [
      parseStyledText(element.content ?? "")
        .map((part) => part.text)
        .join(""),
    ];
  }
  return (element.children ?? []).flatMap(flat);
}

function render(cols = 130, window = 40_000, threadLabel = "main"): string {
  const screen = new OverviewScreen(fixture(threadLabel), "T", DEFAULT_THRESHOLDS, () => window);
  return flat(screen.render({ rows: 30, cols })).join("\n");
}

describe("OverviewScreen", () => {
  it("shows model, state, elapsed time, rounds and cost in the header", () => {
    expect(render()).toMatch(/m1 · done · .* · 3 rounds · \$0\.0\d+/);
  });

  it("names the slowest, priciest and biggest rounds", () => {
    const text = render();
    expect(text).toMatch(/slowest\s+round 2/);
    expect(text).toMatch(/priciest\s+round 2/);
    expect(text).toMatch(/biggest\s+round 3\s+20k ctx/);
  });

  it("draws the ceiling only when the model window is known", () => {
    const withoutWindow = new OverviewScreen(fixture(), "T", DEFAULT_THRESHOLDS, () => undefined);
    expect(flat(withoutWindow.render({ rows: 30, cols: 130 })).join("\n")).not.toContain("┄");
    expect(render()).toContain("┄");
  });

  it("opens a callout in the trace", () => {
    const screen = new OverviewScreen(fixture(), "T", DEFAULT_THRESHOLDS, () => 40_000);
    screen.handleKey({ key: "tab" }, { rows: 30, cols: 130 });
    expect(screen.handleKey({ key: "enter" }, { rows: 30, cols: 130 })).toEqual({
      kind: "openScreen",
      screen: "trace",
      focusId: "round:L:1",
    });
  });

  it("opens a time group's occurrences", () => {
    const screen = new OverviewScreen(fixture(), "T", DEFAULT_THRESHOLDS, () => 40_000);
    expect(screen.handleKey({ key: "enter" }, { rows: 30, cols: 130 })).toEqual({
      kind: "openOccurrences",
      groupKey: expect.stringContaining("llm("),
    });
  });

  it("passes shared focus through unchanged", () => {
    const screen = new OverviewScreen(fixture(), "T", DEFAULT_THRESHOLDS, () => 40_000);
    screen.setFocus("round:L:2");
    expect(screen.focusId()).toBe("round:L:2");
  });

  it("draws a thread label containing a style tag as written", () => {
    expect(render(130, 40_000, "{bold}")).toContain("{bold}");
  });

  it.each([100, 130, 200])("fits every row at %d columns", (cols) => {
    const rows = render(cols).split("\n");
    expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(cols);
  });

  it.each([100, 130, 200])("renders the golden frame at %d columns", (cols) => {
    expect(render(cols)).toMatchSnapshot();
  });
});
