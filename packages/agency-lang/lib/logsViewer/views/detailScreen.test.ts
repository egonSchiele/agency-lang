import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { leaf, span, trace } from "../timeline/fixture.js";
import { DetailScreen } from "./detailScreen.js";
import type { Element } from "../../tui/elements.js";

const viewport = { rows: 10, cols: 40 };

function flat(el: Element): string[] {
  if (el.type === "text") return [el.content ?? ""];
  return (el.children ?? []).flatMap(flat);
}

function llmForest() {
  const call = span("llmCall", [
    leaf("promptCompletion", 1_000, {
      model: '"claude-sonnet-5"',
      timeTaken: 400,
      usage: { inputTokens: 120, outputTokens: 30 },
      cost: { totalCost: 0.0123 },
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "what is 2+2" },
      ],
      completion: { output: "4", toolCalls: [] },
    }),
  ], { id: "L1" });
  return [trace([call])];
}

function toolForest() {
  const call = span("toolExecution", [
    leaf("toolCallStart", 100, { toolName: "bash", args: { command: "x".repeat(300) } }),
    leaf("toolCall", 200, { toolName: "bash" }),
  ], { id: "T1" });
  return [trace([call])];
}

describe("DetailScreen", () => {
  it("llm details carry model, tokens, cost, and the full transcript", () => {
    const screen = new DetailScreen(llmForest(), "L1", DEFAULT_THRESHOLDS);
    const text = flat(screen.render({ rows: 40, cols: 120 })).join("\n");
    expect(text).toContain("model: claude-sonnet-5");
    expect(text).toContain("120 in / 30 out");
    expect(text).toContain("$0.0123");
    expect(text).toContain("what is 2+2");
    expect(text).toContain("4");
  });

  it("tool details carry the untruncated arguments", () => {
    const screen = new DetailScreen(toolForest(), "T1", DEFAULT_THRESHOLDS);
    expect(screen.allLines(10_000).join("\n")).toContain("x".repeat(300));
    expect(screen.allLines(120).join("").match(/x/g)!.length).toBeGreaterThanOrEqual(300);
  });

  it("long lines wrap and the scroll clamp uses the POST-wrap count", () => {
    const screen = new DetailScreen(toolForest(), "T1", DEFAULT_THRESHOLDS);
    const wrapped = screen.allLines(viewport.cols);
    expect(wrapped.length).toBeGreaterThan(screen.allLines(10_000).length);
    for (let i = 0; i < 200; i++) screen.handleKey({ key: "down" }, viewport);
    const bottomFrame = flat(screen.render(viewport));
    expect(bottomFrame.join("\n")).toContain(`of ${wrapped.length}`);
  });

  it("y returns the whole page as a copy action", () => {
    const screen = new DetailScreen(llmForest(), "L1", DEFAULT_THRESHOLDS);
    const action = screen.handleKey({ key: "y" }, viewport);
    expect(action.kind).toBe("copy");
    if (action.kind === "copy") {
      expect(action.text).toContain("what is 2+2");
    }
  });

  it("escape and left go back", () => {
    const screen = new DetailScreen(llmForest(), "L1", DEFAULT_THRESHOLDS);
    expect(screen.handleKey({ key: "escape" }, viewport)).toEqual({ kind: "back" });
    expect(screen.handleKey({ key: "left" }, viewport)).toEqual({ kind: "back" });
  });

  it("a vanished span (follow re-parse) backs out instead of crashing", () => {
    const screen = new DetailScreen(llmForest(), "L1", DEFAULT_THRESHOLDS);
    screen.setData(toolForest());
    expect(screen.handleKey({ key: "down" }, viewport)).toEqual({ kind: "back" });
  });
});
