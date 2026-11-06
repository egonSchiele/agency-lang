import { describe, expect, it } from "vitest";
import {
  ToolCall,
  assistantMessage,
  systemMessage,
  toolMessage,
  userMessage,
  type Message,
} from "smoltalk";
import { withMetadata } from "../runtime/state/messageMetadata.js";
import {
  SUMMARY_PREFIX,
  compactedMessages,
  contextTokens,
  estimateTokens,
  planCompaction,
  transcriptText,
} from "./agentCompaction.js";

// Each of these is 100 characters, so 25 estimated tokens.
const user = (label: string) => userMessage(label.padEnd(100, "."));
const assistant = (label: string) => assistantMessage(label.padEnd(100, "."));
const tool = (label: string) =>
  toolMessage(label.padEnd(100, "."), { tool_call_id: "c1", name: "read" });

const labels = (messages: Message[]) =>
  messages.map((message) => String(message.content).replace(/\.+$/, ""));

describe("contextTokens", () => {
  it("estimates from the text when no reply carries a count", () => {
    expect(contextTokens([user("u1"), assistant("a1")])).toBe(50);
  });

  it("uses the last reply's count plus an estimate of what follows", () => {
    const counted = assistantMessage("a1", {
      usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 5000 },
    });
    expect(contextTokens([user("u1"), counted, user("u2")])).toBe(6200 + 25);
  });
});

describe("planCompaction", () => {
  const system = systemMessage("You are an agent.");
  const turns = [
    user("u1"),
    assistant("a1"),
    user("u2"),
    assistant("a2-call"),
    tool("t2"),
    assistant("a2"),
    user("u3"),
    assistant("a3"),
  ];

  it("keeps the recent messages and summarizes the rest, cutting at a user message", () => {
    const plan = planCompaction([system, ...turns], 60);
    expect(plan).not.toBeNull();
    expect(labels(plan!.head)).toEqual(["You are an agent"]);
    expect(labels(plan!.summarized)).toEqual(["u1", "a1", "u2", "a2-call", "t2", "a2"]);
    expect(labels(plan!.kept)).toEqual(["u3", "a3"]);
    expect(plan!.previousSummary).toBeNull();
  });

  it("moves the cut forward to the next user message", () => {
    // 110 tokens fit a2-call onward, which would start the kept part
    // mid-turn. The next user message is u3.
    const plan = planCompaction([system, ...turns], 110);
    expect(labels(plan!.kept)).toEqual(["u3", "a3"]);
  });

  it("starts at an assistant message when no user message is recent enough", () => {
    const oneLongTurn = [user("u1"), assistant("a1-call"), tool("t1"), assistant("a1")];
    const plan = planCompaction(oneLongTurn, 60);
    expect(labels(plan!.summarized)).toEqual(["u1", "a1-call", "t1"]);
    expect(labels(plan!.kept)).toEqual(["a1"]);
  });

  it("never starts the kept part at a tool result", () => {
    const oneLongTurn = [user("u1"), assistant("a1-call"), tool("t1"), tool("t1b")];
    expect(planCompaction(oneLongTurn, 30)).toBeNull();
  });

  it("is null when everything fits", () => {
    expect(planCompaction([system, ...turns], 10000)).toBeNull();
  });

  it("replaces an earlier summary and hands its text to the next one", () => {
    const earlier = systemMessage(`${SUMMARY_PREFIX}They fixed the parser.`);
    const plan = planCompaction([system, earlier, ...turns], 60);
    expect(labels(plan!.head)).toEqual(["You are an agent"]);
    expect(plan!.previousSummary).toBe("They fixed the parser.");
  });

  it("keeps an expiring message in the thread and out of the summary", () => {
    const expiring = withMetadata(user("soon-gone"), {
      expires: { at: "llmCall", key: "k1" },
    });
    const plan = planCompaction([system, user("u1"), expiring, assistant("a1"), user("u2")], 30);
    expect(labels(plan!.summarized)).toEqual(["u1", "a1"]);
    expect(labels(plan!.kept)).toEqual(["soon-gone", "u2"]);
  });
});

describe("compactedMessages", () => {
  it("puts the summary after the system messages and before the kept ones", () => {
    const plan = planCompaction(
      [systemMessage("sys"), user("u1"), assistant("a1"), user("u2")],
      30,
    );
    const messages = compactedMessages(plan!, "They said hello.");
    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
    expect(messages[1].content).toBe(`${SUMMARY_PREFIX}They said hello.`);
  });

  it("is smaller than the thread it replaces", () => {
    const before = [systemMessage("sys"), user("u1"), assistant("a1"), user("u2")];
    const after = compactedMessages(planCompaction(before, 30)!, "Short.");
    expect(estimateTokens(after)).toBeLessThan(estimateTokens(before));
  });
});

describe("transcriptText", () => {
  it("labels each message with its role", () => {
    expect(transcriptText([userMessage("hi"), assistantMessage("hello")])).toBe(
      "[user] hi\n\n[assistant] hello",
    );
  });

  it("cuts a long tool result and leaves other messages whole", () => {
    const long = "x".repeat(5000);
    const text = transcriptText([
      toolMessage(long, { tool_call_id: "c1", name: "read" }),
      userMessage(long),
    ]);
    const [toolPart, userPart] = text.split("\n\n[user] ");
    expect(toolPart).toBe(`[tool] ${"x".repeat(2000)}\n[cut]`);
    expect(userPart).toBe(long);
  });

  it("shows the tools an assistant message called", () => {
    const calling = assistantMessage("", {
      toolCalls: [new ToolCall("c1", "read", { filename: "a.ts" })],
    });
    expect(transcriptText([calling])).toContain('read({"filename":"a.ts"})');
  });
});
