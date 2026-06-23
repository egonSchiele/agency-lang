import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { _internal } from "./prompt.js";
import { MessageThread } from "./state/messageThread.js";

const {
  DEFAULT_TOOL_RESULT_CHARS,
  stringifyToolResult,
  capToolResultForLlm,
  assertUniqueToolNames,
  markThreadCancelled,
} = _internal;

/** Convenience builders for the markThreadCancelled repair-shape tests. */
const asst = (text: string, toolCalls?: Array<{ id: string; name: string }>) =>
  smoltalk.assistantMessage(
    text,
    toolCalls
      ? { toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: {} })) }
      : undefined,
  );
const tool = (id: string) =>
  smoltalk.toolMessage("ok", { tool_call_id: id, name: "f" });
const roles = (t: MessageThread) => t.getMessages().map((m) => m.role);

describe("markThreadCancelled — non-destructive repair", () => {
  it("complete trailing turn (no tool_calls): preserves the assistant text turn and appends marker", () => {
    const t = new MessageThread([smoltalk.userMessage("hi"), asst("hi there")]);
    markThreadCancelled(t);
    const msgs = t.getMessages();
    // Old truncating impl would drop the assistant text turn back to the user.
    expect(roles(t)).toEqual(["user", "assistant", "assistant"]);
    expect((msgs[1] as smoltalk.AssistantMessage).content).toBe("hi there");
    expect((msgs[2] as smoltalk.AssistantMessage).content).toBe("[Response cancelled.]");
  });

  it("partial tool batch: stubs missing tool responses, preserves the answered one + the marker", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [
        { id: "a", name: "f" },
        { id: "b", name: "f" },
        { id: "c", name: "f" },
      ]),
      tool("a"),
    ]);
    markThreadCancelled(t);
    expect(roles(t)).toEqual(["user", "assistant", "tool", "tool", "tool", "assistant"]);
    const ids = t
      .getMessages()
      .filter((m): m is smoltalk.ToolMessage => m instanceof smoltalk.ToolMessage)
      .map((m) => m.tool_call_id);
    expect(ids).toEqual(["a", "b", "c"]); // a preserved, b+c synthesized
    const last = t.getMessages().at(-1) as smoltalk.AssistantMessage;
    expect(last.content).toBe("[Response cancelled.]");
  });

  it("earlier complete round + new dangling assistant: preserves the first round AND the dangling text body", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "x", name: "f" }]),
      tool("x"),
      asst("thinking", [{ id: "y", name: "f" }]),
    ]);
    markThreadCancelled(t);
    expect(roles(t)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    // The dangling assistant's text body survives.
    expect((t.getMessages()[3] as smoltalk.AssistantMessage).content).toBe("thinking");
    // The new stub answers tool_call y.
    const stub = t.getMessages()[4] as smoltalk.ToolMessage;
    expect(stub.tool_call_id).toBe("y");
  });

  it("no assistant yet: no-op", () => {
    const t = new MessageThread([smoltalk.userMessage("hi")]);
    markThreadCancelled(t);
    expect(roles(t)).toEqual(["user"]);
  });
});

describe("assertUniqueToolNames", () => {
  it("accepts a list of distinct tool names", () => {
    expect(() =>
      assertUniqueToolNames([{ name: "read" }, { name: "write" }]),
    ).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => assertUniqueToolNames([])).not.toThrow();
  });

  it("throws naming the duplicate (the skillsDir/read regression)", () => {
    // Four skillsDir tools used to all be named `read` (read.partial keeps
    // the base name), which Anthropic rejects with an opaque 400.
    expect(() =>
      assertUniqueToolNames([
        { name: "read" },
        { name: "read" },
        { name: "read" },
        { name: "write" },
      ]),
    ).toThrow(/Duplicate tool name\(s\).*"read" \(×3\)/s);
  });

  it("points at .rename() in the message", () => {
    expect(() =>
      assertUniqueToolNames([{ name: "x" }, { name: "x" }]),
    ).toThrow(/\.rename\(/);
  });
});

describe("stringifyToolResult", () => {
  it("passes strings through unchanged", () => {
    expect(stringifyToolResult("hello")).toBe("hello");
  });

  it("JSON-stringifies objects/arrays", () => {
    expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}');
    expect(stringifyToolResult([1, 2])).toBe("[1,2]");
  });

  it("falls back to String() on circular structures", () => {
    const a: any = {};
    a.self = a;
    // Does not throw; returns some string representation.
    expect(typeof stringifyToolResult(a)).toBe("string");
  });
});

describe("capToolResultForLlm", () => {
  it("returns the original value untouched when within the cap", () => {
    const obj = { big: "x".repeat(100) };
    // Object under cap → returned as-is (object identity), so smoltalk
    // serializes it exactly as before — no behavior change.
    expect(capToolResultForLlm(obj, 1000)).toBe(obj);
    expect(capToolResultForLlm("short", 1000)).toBe("short");
  });

  it("truncates an over-cap string and appends a marker", () => {
    const out = capToolResultForLlm("a".repeat(5000), 100) as string;
    expect(typeof out).toBe("string");
    expect(out.startsWith("a".repeat(100))).toBe(true);
    expect(out).toContain("truncated");
    // Marker reports the original length.
    expect(out).toContain("of 5000");
    // First `cap` chars are preserved verbatim before the marker.
    expect(out.slice(0, 100)).toBe("a".repeat(100));
  });

  it("truncates an over-cap object (by its serialized form)", () => {
    const big = { data: "y".repeat(5000) };
    const out = capToolResultForLlm(big, 100);
    expect(typeof out).toBe("string");
    expect(out).toContain("truncated");
  });

  it("cap of 0 disables the cap (returns original)", () => {
    const huge = "z".repeat(1_000_000);
    expect(capToolResultForLlm(huge, 0)).toBe(huge);
  });

  it("non-finite cap (Infinity) disables the cap", () => {
    const huge = "z".repeat(1_000_000);
    expect(capToolResultForLlm(huge, Infinity)).toBe(huge);
  });

  it("default cap is 100000 characters", () => {
    expect(DEFAULT_TOOL_RESULT_CHARS).toBe(100_000);
    const justOver = "q".repeat(DEFAULT_TOOL_RESULT_CHARS + 1);
    const out = capToolResultForLlm(justOver, DEFAULT_TOOL_RESULT_CHARS) as string;
    expect(out.slice(0, DEFAULT_TOOL_RESULT_CHARS)).toBe(
      "q".repeat(DEFAULT_TOOL_RESULT_CHARS),
    );
    expect(out).toContain("truncated");
  });
});
