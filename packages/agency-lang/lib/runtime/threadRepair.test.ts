import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { makeAbortCause } from "./errors.js";
import { MessageThread } from "./state/messageThread.js";
import {
  markThreadCancelled,
  needsThreadRepair,
  unansweredToolCalls,
} from "./threadRepair.js";

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

describe("needsThreadRepair — repair policy", () => {
  it("repairs only user-initiated cancels; never guard/race/cleanup; conservative default", () => {
    // Conservative default for absent/unknown causes (matches pre-cause behavior).
    expect(needsThreadRepair(undefined)).toBe(true);
    // User-initiated cancels DO warrant repair.
    expect(needsThreadRepair(makeAbortCause({ kind: "userInterrupt" }))).toBe(true);
    expect(needsThreadRepair(makeAbortCause({ kind: "userKill" }))).toBe(true);
    // Guard trip / race loser / cleanup do NOT (their Failure path wants the
    // in-flight turn intact).
    expect(
      needsThreadRepair(
        makeAbortCause({
          kind: "guardTrip",
          dimension: "time",
          limit: 1,
          spent: 2,
          guardId: "g1",
        }),
      ),
    ).toBe(false);
    expect(needsThreadRepair(makeAbortCause({ kind: "raceLoser" }))).toBe(false);
    expect(needsThreadRepair(makeAbortCause({ kind: "cleanup" }))).toBe(false);
  });
});

describe("unansweredToolCalls", () => {
  it("returns only the trailing assistant turn's unanswered calls", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "x", name: "f" }]),
      tool("x"),
      asst("", [
        { id: "a", name: "whatIAmDoing" },
        { id: "b", name: "codeAgent" },
      ]),
      tool("a"),
    ]);
    expect(unansweredToolCalls(t).map((c) => c.id)).toEqual(["b"]);
  });

  it("ignores unanswered calls on EARLIER assistant turns — the contract is trailing-turn only", () => {
    const t = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "old", name: "f" }]), // never answered, but not trailing
      asst("", [{ id: "new", name: "f" }]),
    ]);
    expect(unansweredToolCalls(t).map((c) => c.id)).toEqual(["new"]);
  });

  it("trailing assistant with no tool calls (an ordinary reply) reports empty", () => {
    const t = new MessageThread([smoltalk.userMessage("hi"), asst("hello")]);
    expect(unansweredToolCalls(t)).toEqual([]);
  });

  it("valid tail and no-assistant threads both report empty", () => {
    const valid = new MessageThread([
      smoltalk.userMessage("go"),
      asst("", [{ id: "x", name: "f" }]),
      tool("x"),
    ]);
    expect(unansweredToolCalls(valid)).toEqual([]);
    expect(unansweredToolCalls(new MessageThread([smoltalk.userMessage("hi")]))).toEqual([]);
  });
});

describe("markThreadCancelled — label preservation (push, not setMessages)", () => {
  it("keeps per-message debug labels on the right messages and stays aligned", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("go"), "the-user-msg");
    t.push(asst("", [{ id: "y", name: "f" }]), "the-tool-round");
    markThreadCancelled(t);
    expect(t.labelAt(0)).toBe("the-user-msg");
    expect(t.labelAt(1)).toBe("the-tool-round");
    expect(roles(t)).toEqual(["user", "assistant", "tool", "assistant"]);
    // The alignment invariant messageThread.ts warns about: lengths match.
    expect(t.messageLabels.length).toBe(t.getMessages().length);
  });
});
