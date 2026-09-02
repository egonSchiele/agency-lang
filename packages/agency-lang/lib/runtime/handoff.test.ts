import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import {
  applyHandoffMarker,
  finishHandoff,
  handoffMarkerText,
  handoffNotAloneMessage,
  handoffResumeText,
} from "./handoff.js";

const toolCall = () => new smoltalk.ToolCall("call-1", "explorer", { question: "why" });

describe("applyHandoffMarker", () => {
  it("keeps the assistant's text, drops the tool call, appends the marker, keeps the label", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(
      smoltalk.assistantMessage("I'll ask the explorer.", { toolCalls: [toolCall()] }),
      "main",
    );
    const start = applyHandoffMarker(thread, "explorer", { question: "why" });
    const last = thread.getMessages()[1];
    expect(start).toBe(2);
    expect(last.role).toBe("assistant");
    expect(last.content).toBe(
      `I'll ask the explorer.\n\n${handoffMarkerText("explorer", { question: "why" })}`,
    );
    const json = last.toJSON() as { toolCalls?: unknown[] };
    expect(json.toolCalls ?? []).toEqual([]);
    expect(thread.labelAt(1)).toBe("main");
  });

  it("uses the marker alone when the assistant wrote no text", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(smoltalk.assistantMessage(null, { toolCalls: [toolCall()] }));
    applyHandoffMarker(thread, "explorer", { question: "why" });
    expect(thread.getMessages()[1].content).toBe(
      handoffMarkerText("explorer", { question: "why" }),
    );
  });

  it("refuses a thread that does not end on an assistant message", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    expect(() => applyHandoffMarker(thread, "explorer", {})).toThrow(/assistant/);
  });
});

describe("finishHandoff", () => {
  it("removes system messages pushed since the start index and hands control back", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.systemMessage("caller persona"));
    thread.push(smoltalk.userMessage("hello"));
    thread.push(smoltalk.assistantMessage(handoffMarkerText("explorer", {})));
    const start = thread.getMessages().length;
    thread.push(smoltalk.systemMessage("subagent persona"));
    thread.push(smoltalk.userMessage("brief"));
    thread.push(smoltalk.assistantMessage("the answer"));
    finishHandoff(thread, start, "explorer", "the answer");
    const roles = thread.getMessages().map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(thread.getMessages()[0].content).toBe("caller persona");
    expect(thread.getMessages()[5].content).toBe(handoffResumeText("explorer", "the answer"));
  });
});

describe("message text", () => {
  it("names the tool in every message", () => {
    expect(handoffNotAloneMessage("explorer")).toContain("explorer");
    expect(handoffNotAloneMessage("explorer")).toContain("only tool call");
    expect(handoffMarkerText("explorer", { q: 1 })).toBe('[dispatching explorer: {"q":1}]');
    expect(handoffResumeText("explorer", "x")).toBe(
      "[explorer finished. x]\nContinue with the user's request.",
    );
  });
});
