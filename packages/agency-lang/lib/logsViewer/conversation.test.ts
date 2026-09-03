import { describe, it, expect } from "vitest";
import { formatConversation } from "./conversation.js";
import { color } from "@/utils/termcolors.js";

describe("formatConversation", () => {
  it("formats a simple user/assistant exchange", () => {
    const lines = formatConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    // A user body is cyan and a system body is dim, so both stand apart
    // from assistant and tool text when scrolling a long transcript.
    expect(lines).toEqual([
      `${color.green("[user]")} ${color.cyan("hi")}`,
      `${color.green("[assistant]")} hello`,
    ]);
  });

  it("formats an assistant tool call (camelCase shape)", () => {
    const lines = formatConversation([
      { role: "user", content: "Greet Alice using the greet tool" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "x", name: "greet", arguments: { name: "Alice" } }],
      },
      { role: "tool", name: "greet", content: "Hello, Alice!", tool_call_id: "x" },
      { role: "assistant", content: "Hello, Alice!" },
    ]);
    expect(lines).toEqual([
      `${color.green("[user]")} ${color.cyan("Greet Alice using the greet tool")}`,
      `${color.green("[assistant]")} tool call: greet({"name":"Alice"})`,
      `${color.green("[tool: greet]")} Hello, Alice!`,
      `${color.green("[assistant]")} Hello, Alice!`,
    ]);
  });

  it("handles snake_case tool_calls and JSON-encoded arguments", () => {
    const lines = formatConversation([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "y",
            function: { name: "add", arguments: '{"a":1,"b":2}' },
          },
        ],
      },
    ]);
    expect(lines).toEqual([`${color.green("[assistant]")} tool call: add({"a":1,"b":2})`]);
  });

  it("renders an array content payload as joined text", () => {
    const lines = formatConversation([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
    expect(lines).toEqual([`${color.green("[user]")} ${color.cyan("first second")}`]);
  });

  it("renders a non-content-part array (e.g. a tool result) as JSON", () => {
    // A tool message's content can be the raw return value — here a
    // number array. It must not be mistaken for a multimodal
    // content-parts array (which would extract zero text and render
    // nothing).
    const lines = formatConversation([
      { role: "tool", name: "fibonacciNumbers", content: [0, 1, 1, 2, 3], tool_call_id: "x" },
    ]);
    expect(lines).toEqual([`${color.green("[tool: fibonacciNumbers]")} [0,1,1,2,3]`]);
  });

  it("renders an object tool result as JSON", () => {
    const lines = formatConversation([
      { role: "tool", name: "t", content: { response: [1, 2] }, tool_call_id: "x" },
    ]);
    expect(lines).toEqual([`${color.green("[tool: t]")} {"response":[1,2]}`]);
  });

  it("renders newlines as separate rows, continuation lines indented", () => {
    const lines = formatConversation([
      { role: "system", content: "You are helpful.\nBe brief.\n\nAnswer in English." },
      { role: "tool", name: "read", content: "line 1\nline 2", tool_call_id: "x" },
    ]);
    expect(lines).toEqual([
      `${color.green("[system]")} ${color.dim("You are helpful.")}`,
      `  ${color.dim("Be brief.")}`,
      `  ${color.dim("")}`,
      `  ${color.dim("Answer in English.")}`,
      `${color.green("[tool: read]")} line 1`,
      "  line 2",
    ]);
  });

  it("escapes control characters other than newline", () => {
    const lines = formatConversation([
      { role: "tool", name: "bash", content: "\x1b[2Jcleared\x1b[1;1H\r\tdone\nnext" },
    ]);
    expect(lines).toEqual([
      `${color.green("[tool: bash]")} \\u001b[2Jcleared\\u001b[1;1H\\r\\tdone`,
      "  next",
    ]);
  });

  it("emits a placeholder row for empty turns", () => {
    const lines = formatConversation([{ role: "assistant", content: null }]);
    expect(lines).toEqual([color.green("[assistant]")]);
  });
});
