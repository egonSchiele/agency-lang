import { it, expect } from "vitest";
import { keyFooter, twoLineKeyFooter, tabStrip, tooNarrow } from "./chrome.js";
import { parseStyledText } from "../../tui/styleParser.js";
import type { Element } from "../../tui/elements.js";
function text(element: Element): string {
  return element.type === "text"
    ? parseStyledText(element.content ?? "")
        .map((part) => part.text)
        .join("")
    : (element.children ?? []).map(text).join("\n");
}
it("marks the active slot and shows multi-trace position and literal annotation", () => {
  const value = text(
    tabStrip({
      active: "timeline",
      title: "run",
      tracePosition: { at: 2, of: 5 },
      annotation: "{bold}",
      following: true,
      cols: 200,
    }),
  );
  expect(value).toContain("[4 timeline]");
  expect(value).toContain("trace 2/5");
  expect(value).not.toContain("t traces");
  expect(value).toContain("{bold}");
  expect(value).toContain("● following");
  expect(
    text(
      tabStrip({
        active: "trace",
        title: "run",
        tracePosition: { at: 1, of: 1 },
        following: false,
        cols: 100,
      }),
    ),
  ).not.toContain("t traces");
});
it("explains the minimum width with the actual terminal width", () => {
  expect(text(tooNarrow(78))).toContain("This viewer wants 100 columns; this terminal has 78.");
});

it.each([100, 130, 200])(
  "keeps shared commands and a distinct title visible at %i columns",
  (cols) => {
    const footer = keyFooter(
      "j k move   ⏎ fold   tab pane   r raw   m tree   p approvals   a admin   d detail   / find   F filter",
      cols,
      "TRACE",
      "esc back   q quit   ? help   f follow   t traces",
    );
    const value = text(footer);
    expect(value).toHaveLength(cols);
    expect(value).toMatch(/\[TRACE\]$/);
    expect(value).toContain("esc back   q quit   ? help   f follow   t traces");
    expect(value).toContain("j k move");
    const title = parseStyledText(footer.content ?? "").find((part) =>
      part.text.includes("[TRACE]"),
    );
    expect(title?.bold).toBe(true);
    expect(title?.bg).toBeDefined();
  },
);

it.each([100, 130, 200])(
  "wraps Trace hints at command boundaries across two rows at %i columns",
  (cols) => {
    const hints =
      "j k move   # numbers   space page   [] sibling   ⏎ fold   tab/←→ pane   r raw   m tree   p approvals   a admin   d detail   / find   F filter";
    const shared = "esc back   q quit   ? help   f follow   t traces";
    const lines = text(twoLineKeyFooter(hints, cols, "TRACE", shared)).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.length === cols)).toBe(true);
    for (const hint of [...hints.split("   "), ...shared.split("   ")]) {
      expect(lines.some((line) => line.includes(hint))).toBe(true);
    }
    expect(lines[1]).toMatch(/\[TRACE\]$/);
  },
);
