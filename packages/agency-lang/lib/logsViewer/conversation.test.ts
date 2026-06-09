import { describe, it, expect } from "vitest";
import { formatConversation } from "./conversation.js";
import { color } from "@/utils/termcolors.js";

describe("formatConversation", () => {
  it("formats a simple user/assistant exchange", () => {
    const lines = formatConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(lines).toEqual([
      `${color.green("[user]")} "hi"`,
      `${color.green("[assistant]")} "hello"`,
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
      `${color.green("[user]")} "Greet Alice using the greet tool"`,
      `${color.green("[assistant]")} tool call: greet({"name":"Alice"})`,
      `${color.green("[tool: greet]")} "Hello, Alice!"`,
      `${color.green("[assistant]")} "Hello, Alice!"`,
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
    expect(lines).toEqual([
      `${color.green("[assistant]")} tool call: add({"a":1,"b":2})`,
    ]);
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
    expect(lines).toEqual([`${color.green("[user]")} "first second"`]);
  });

  it("emits a placeholder row for empty turns", () => {
    const lines = formatConversation([{ role: "assistant", content: null }]);
    expect(lines).toEqual([color.green("[assistant]")]);
  });
});
