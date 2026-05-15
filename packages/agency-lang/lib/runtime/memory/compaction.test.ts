import { describe, it, expect } from "vitest";
import {
  userMessage,
  assistantMessage,
  systemMessage,
  toolMessage,
} from "smoltalk";
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
      assistantMessage("4"),
      userMessage("5"),
      assistantMessage("6"),
    ];
    // midpoint = 3, messages[3] is "assistant", walk forward to messages[4] (user)
    expect(findCompactionSplitPoint(messages)).toBe(4);
  });

  it("walks forward past assistant tool_call/tool sequence", () => {
    const messages = [
      userMessage("1"),
      assistantMessage("2"),
      userMessage("3"),
      assistantMessage("4"),
      tm("5"),
      assistantMessage("6"),
      userMessage("7"),
    ];
    // midpoint = 3 (assistant). walk to 6 (user)
    expect(findCompactionSplitPoint(messages)).toBe(6);
  });

  it("returns -1 when no user boundary exists after midpoint", () => {
    const messages = [
      userMessage("1"),
      assistantMessage("2"),
      assistantMessage("3"),
      tm("4"),
    ];
    // midpoint = 2, walk forward — no user message exists after midpoint
    expect(findCompactionSplitPoint(messages)).toBe(-1);
  });

  it("skips system messages at the head when computing midpoint", () => {
    const messages = [
      systemMessage("system1"),
      systemMessage("system2"),
      userMessage("1"),
      assistantMessage("2"),
      userMessage("3"),
      assistantMessage("4"),
    ];
    // 6 messages total, midpoint = 3 (assistant), walk to 4 (user)
    expect(findCompactionSplitPoint(messages)).toBe(4);
  });
});
