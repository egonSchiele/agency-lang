import { describe, it, expect } from "vitest";
import { userMessage, assistantMessage, toolMessage } from "smoltalk";
import {
  buildCompactionPrompt,
  buildMergeSummaryPrompt,
  shouldCompact,
  findCompactionSplitPoint,
} from "./compaction.js";

// Convenience tool-message helper — every test that needs a tool reply
// uses the same dummy id/name.
const tm = (content: string) =>
  toolMessage(content, { tool_call_id: "t1", name: "tool" });

describe("shouldCompact", () => {
  it("returns true when message count exceeds threshold", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      userMessage(`message ${i}`),
    );
    expect(
      shouldCompact(messages, { trigger: "messages", threshold: 10 })
    ).toBe(true);
  });

  it("returns false when under threshold", () => {
    const messages = [userMessage("hi")];
    expect(
      shouldCompact(messages, { trigger: "messages", threshold: 10 })
    ).toBe(false);
  });

  it("estimates tokens for token-based trigger", () => {
    const messages = [userMessage("a".repeat(4000))];
    expect(
      shouldCompact(messages, { trigger: "token", threshold: 500 })
    ).toBe(true);
  });
});

describe("buildCompactionPrompt", () => {
  it("includes messages to summarize", () => {
    const messages = [
      userMessage("I want a gift for mom"),
      assistantMessage("What does she like?"),
    ];
    const prompt = buildCompactionPrompt(messages);
    expect(prompt).toContain("I want a gift for mom");
    expect(prompt).toContain("What does she like?");
  });
});

describe("buildMergeSummaryPrompt", () => {
  it("includes both old and new summaries", () => {
    const prompt = buildMergeSummaryPrompt(
      "Old summary text",
      "New summary text"
    );
    expect(prompt).toContain("Old summary text");
    expect(prompt).toContain("New summary text");
  });
});

describe("findCompactionSplitPoint", () => {
  it("returns midpoint when midpoint is a user message", () => {
    const messages = [
      userMessage("1"),
      assistantMessage("2"),
      userMessage("3"),
      userMessage("4"),
      userMessage("5"),
      assistantMessage("6"),
    ];
    // midpoint = 3, messages[3] is a user message — split right there
    expect(findCompactionSplitPoint(messages)).toBe(3);
  });

  it("accepts an assistant message as the boundary", () => {
    const messages = [
      userMessage("1"),
      assistantMessage("2"),
      userMessage("3"),
      assistantMessage("4"),
      tm("5"),
      assistantMessage("6"),
      userMessage("7"),
    ];
    // midpoint = 3 (assistant) — an assistant boundary is clean: its
    // tool reply at 4 stays on the same (kept) side
    expect(findCompactionSplitPoint(messages)).toBe(3);
  });

  it("finds a split in a tool loop with no user messages past the midpoint", () => {
    // The agentic shape: one user request, then assistant/tool pairs.
    const messages = [
      userMessage("do the task"),
      assistantMessage("calling tool", { toolCalls: [] }),
      tm("result 1"),
      assistantMessage("calling tool again", { toolCalls: [] }),
      tm("result 2"),
      assistantMessage("done"),
    ];
    // midpoint = 3 (assistant) — must not return -1
    expect(findCompactionSplitPoint(messages)).toBe(3);
  });

  it("never returns the index of a tool reply", () => {
    const messages = [
      userMessage("1"),
      assistantMessage("2"),
      tm("3"),
      tm("4"),
      tm("5"),
      assistantMessage("6"),
    ];
    // midpoint = 3 (tool) — walk past the tool replies to 5 (assistant)
    expect(findCompactionSplitPoint(messages)).toBe(5);
  });

  it("returns -1 when only tool replies exist after midpoint", () => {
    const messages = [
      userMessage("1"),
      assistantMessage("2"),
      tm("3"),
      tm("4"),
    ];
    // midpoint = 2, everything after is tool replies — no clean boundary
    expect(findCompactionSplitPoint(messages)).toBe(-1);
  });
});
