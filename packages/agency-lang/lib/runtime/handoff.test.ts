import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import {
  applyHandoffMarker,
  finishHandoff,
  handoffMarkerText,
  handoffNotAloneMessage,
  handoffResumeText,
  stripHandoffSystemMessages,
} from "./handoff.js";

const toolCall = () => new smoltalk.ToolCall("call-1", "explorer", { question: "why" });
const args = { question: "why" };

const contents = (thread: MessageThread) => thread.getMessages().map((message) => message.content);
const roles = (thread: MessageThread) => thread.getMessages().map((message) => message.role);

describe("applyHandoffMarker", () => {
  it("keeps the assistant's text, drops the tool call, appends the marker, keeps the label", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(
      smoltalk.assistantMessage("I'll ask the explorer.", { toolCalls: [toolCall()] }),
      "main",
    );
    applyHandoffMarker(thread, "explorer", args);
    const last = thread.getMessages()[1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe(`I'll ask the explorer.\n\n${handoffMarkerText("explorer", args)}`);
    const json = last.toJSON() as { toolCalls?: unknown[] };
    expect(json.toolCalls ?? []).toEqual([]);
    expect(thread.labelAt(1)).toBe("main");
  });

  it("uses the marker alone when the assistant wrote no text", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(smoltalk.assistantMessage(null, { toolCalls: [toolCall()] }));
    applyHandoffMarker(thread, "explorer", args);
    expect(thread.getMessages()[1].content).toBe(handoffMarkerText("explorer", args));
  });

  it("refuses a thread that does not end on an assistant message", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    expect(() => applyHandoffMarker(thread, "explorer", {})).toThrow(/assistant/);
  });
});

/** A thread as it stands when a handoff body returns: the caller's own
 *  system prompt, the marker, then the body's persona and work. */
const threadAfterBody = () => {
  const thread = new MessageThread();
  thread.push(smoltalk.systemMessage("caller persona"));
  thread.push(smoltalk.userMessage("hello"));
  thread.push(smoltalk.assistantMessage(handoffMarkerText("explorer", args)));
  thread.push(smoltalk.systemMessage("subagent persona"));
  thread.push(smoltalk.userMessage("brief"));
  thread.push(smoltalk.assistantMessage("the answer"));
  return thread;
};

describe("finishHandoff", () => {
  it("removes the system messages after the marker and hands control back", () => {
    const thread = threadAfterBody();
    finishHandoff(thread, "explorer", args, "the answer");
    expect(roles(thread)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(contents(thread)[0]).toBe("caller persona");
    expect(contents(thread)[5]).toBe(handoffResumeText("explorer", "the answer"));
  });

  it("strips only after the newest marker for this dispatch", () => {
    const thread = threadAfterBody();
    thread.push(smoltalk.userMessage(handoffResumeText("explorer", "the answer")));
    thread.push(smoltalk.assistantMessage(handoffMarkerText("explorer", args)));
    thread.push(smoltalk.systemMessage("second persona"));
    thread.push(smoltalk.assistantMessage("second answer"));
    // The first dispatch's persona is still there because nothing stripped
    // it in this synthetic thread; the second dispatch must not reach back
    // past its own marker and remove it.
    finishHandoff(thread, "explorer", args, "second answer");
    expect(contents(thread)).toContain("subagent persona");
    expect(contents(thread)).not.toContain("second persona");
  });

  it("survives memory compaction shifting every index", () => {
    const thread = threadAfterBody();
    // Compaction keeps the leading system prefix, replaces a middle run
    // with one summary, and keeps the tail. Here the marker and the
    // persona sit in the tail, one position lower than before.
    const original = thread.getMessages();
    const summary = smoltalk.systemMessage("summary of earlier turns");
    thread.setMessages([original[0], summary, original[2], original[3], original[4], original[5]]);
    finishHandoff(thread, "explorer", args, "the answer");
    expect(contents(thread)).toContain("summary of earlier turns");
    expect(contents(thread)).not.toContain("subagent persona");
    expect(roles(thread)).toEqual(["system", "system", "assistant", "user", "assistant", "user"]);
  });

  it("leaves a compacted-away dispatch alone and still hands back", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.systemMessage("caller persona"));
    thread.push(smoltalk.systemMessage("summary that swallowed the marker and the persona"));
    thread.push(smoltalk.assistantMessage("the answer"));
    finishHandoff(thread, "explorer", args, "the answer");
    expect(roles(thread)).toEqual(["system", "system", "assistant", "user"]);
  });
});

describe("stripHandoffSystemMessages", () => {
  it("removes the body's system messages without a resume message, for a cancelled dispatch", () => {
    const thread = threadAfterBody();
    stripHandoffSystemMessages(thread, "explorer", args);
    expect(contents(thread)).not.toContain("subagent persona");
    expect(roles(thread)).toEqual(["system", "user", "assistant", "user", "assistant"]);
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
