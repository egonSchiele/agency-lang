import { it, expect } from "vitest";
import { tabStrip, tooNarrow } from "./chrome.js";
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
  expect(value).toContain("trace 2/5 · t traces");
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
