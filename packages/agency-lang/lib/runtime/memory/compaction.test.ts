import { describe, it, expect } from "vitest";
import {
  buildCompactionPrompt,
  buildMergeSummaryPrompt,
  shouldCompact,
  findCompactionSplitPoint,
} from "./compaction.js";

describe("shouldCompact", () => {
  it("returns true when message count exceeds threshold", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
    }));
    expect(
      shouldCompact(messages, { trigger: "messages", threshold: 10 })
    ).toBe(true);
  });

  it("returns false when under threshold", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(
      shouldCompact(messages, { trigger: "messages", threshold: 10 })
    ).toBe(false);
  });

  it("estimates tokens for token-based trigger", () => {
    const messages = [{ role: "user" as const, content: "a".repeat(4000) }];
    expect(
      shouldCompact(messages, { trigger: "token", threshold: 500 })
    ).toBe(true);
  });
});

describe("buildCompactionPrompt", () => {
  it("includes messages to summarize", () => {
    const messages = [
      { role: "user" as const, content: "I want a gift for mom" },
      { role: "assistant" as const, content: "What does she like?" },
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
      { role: "user" as const, content: "1" },
      { role: "assistant" as const, content: "2" },
      { role: "user" as const, content: "3" },
      { role: "assistant" as const, content: "4" },
      { role: "user" as const, content: "5" },
      { role: "assistant" as const, content: "6" },
    ];
    // midpoint = 3, messages[3] is "assistant", walk forward to messages[4] (user)
    expect(findCompactionSplitPoint(messages)).toBe(4);
  });

  it("walks forward past assistant tool_call/tool sequence", () => {
    const messages = [
      { role: "user" as const, content: "1" },
      { role: "assistant" as const, content: "2" },
      { role: "user" as const, content: "3" },
      { role: "assistant" as const, content: "4" },
      { role: "tool" as const, content: "5" },
      { role: "assistant" as const, content: "6" },
      { role: "user" as const, content: "7" },
    ];
    // midpoint = 3 (assistant). walk to 6 (user)
    expect(findCompactionSplitPoint(messages)).toBe(6);
  });

  it("returns -1 when no user boundary exists after midpoint", () => {
    const messages = [
      { role: "user" as const, content: "1" },
      { role: "assistant" as const, content: "2" },
      { role: "assistant" as const, content: "3" },
      { role: "tool" as const, content: "4" },
    ];
    // midpoint = 2, walk forward — no user message exists after midpoint
    expect(findCompactionSplitPoint(messages)).toBe(-1);
  });

  it("skips system messages at the head when computing midpoint", () => {
    const messages = [
      { role: "system" as const, content: "system1" },
      { role: "system" as const, content: "system2" },
      { role: "user" as const, content: "1" },
      { role: "assistant" as const, content: "2" },
      { role: "user" as const, content: "3" },
      { role: "assistant" as const, content: "4" },
    ];
    // 6 messages total, midpoint = 3 (assistant), walk to 4 (user)
    expect(findCompactionSplitPoint(messages)).toBe(4);
  });
});
