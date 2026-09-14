import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import {
  dropHandoffToolCall,
  finishHandoff,
  finishStoppedHandoff,
  handoffNotAloneMessage,
  handoffResumeText,
  handoffScopeKey,
  stripHandoffSystemMessages,
} from "./handoff.js";

const toolCall = () => new smoltalk.ToolCall("call-1", "explorer", { question: "why" });
const scopeKey = handoffScopeKey("explorer", "call-1");

const contents = (thread: MessageThread) => thread.getMessages().map((message) => message.content);
const roles = (thread: MessageThread) => thread.getMessages().map((message) => message.role);

describe("dropHandoffToolCall", () => {
  it("keeps the assistant's text, drops the tool call, keeps the label", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(
      smoltalk.assistantMessage("I'll ask the explorer.", { toolCalls: [toolCall()] }),
      "main",
    );
    dropHandoffToolCall(thread);
    const last = thread.getMessages()[1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("I'll ask the explorer.");
    const json = last.toJSON() as { toolCalls?: unknown[] };
    expect(json.toolCalls ?? []).toEqual([]);
    expect(thread.labelAt(1)).toBe("main");
  });

  it("removes the message when the assistant wrote no text", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(smoltalk.assistantMessage(null, { toolCalls: [toolCall()] }));
    dropHandoffToolCall(thread);
    expect(roles(thread)).toEqual(["user"]);
  });

  it("refuses a thread that does not end on an assistant message", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    expect(() => dropHandoffToolCall(thread)).toThrow(/assistant/);
  });
});

/** A thread as it stands when a handoff body returns: the caller's own
 *  system prompt and request, then the body's persona and work, pushed
 *  while the dispatch's scope was open. */
const threadAfterBody = () => {
  const thread = new MessageThread();
  thread.push(smoltalk.systemMessage("caller persona"));
  thread.push(smoltalk.userMessage("hello"));
  thread.enterHandoffScope(scopeKey);
  thread.push(smoltalk.systemMessage("subagent persona"));
  thread.push(smoltalk.userMessage("brief"));
  thread.push(smoltalk.assistantMessage("the answer"));
  thread.exitHandoffScope();
  return thread;
};

describe("finishHandoff", () => {
  it("removes the body's system messages and hands control back", () => {
    const thread = threadAfterBody();
    finishHandoff({ thread, scopeKey, toolName: "explorer", body: "the answer" });
    expect(roles(thread)).toEqual(["system", "user", "user", "assistant", "user"]);
    expect(contents(thread)[0]).toBe("caller persona");
    expect(contents(thread)[4]).toBe(handoffResumeText("explorer", "the answer"));
  });

  it("leaves nothing on the thread that narrates the dispatch", () => {
    const thread = threadAfterBody();
    finishHandoff({ thread, scopeKey, toolName: "explorer", body: "the answer" });
    expect(contents(thread).join("\n")).not.toContain("dispatching");
  });

  it("removes only this dispatch's system messages", () => {
    const thread = threadAfterBody();
    thread.push(smoltalk.userMessage(handoffResumeText("explorer", "the answer")));
    const second = handoffScopeKey("explorer", "call-2");
    thread.enterHandoffScope(second);
    thread.push(smoltalk.systemMessage("second persona"));
    thread.push(smoltalk.assistantMessage("second answer"));
    thread.exitHandoffScope();
    // The first dispatch's persona is still there because nothing stripped
    // it in this synthetic thread; the second dispatch must not remove it.
    finishHandoff({ thread, scopeKey: second, toolName: "explorer", body: "second answer" });
    expect(contents(thread)).toContain("subagent persona");
    expect(contents(thread)).not.toContain("second persona");
  });

  it("survives memory compaction shifting every index", () => {
    const thread = threadAfterBody();
    // Compaction keeps the leading system prefix, replaces a middle run
    // with one summary, and keeps the tail with its scopes.
    const original = thread.getMessages();
    const summary = smoltalk.systemMessage("summary of earlier turns");
    const kept = [0, 2, 3, 4];
    thread.setMessages(
      [original[0], summary, ...kept.slice(1).map((i) => original[i])],
      [null, null, null, null, null],
      [null, null, ...kept.slice(1).map((i) => thread.scopeAt(i))],
    );
    finishHandoff({ thread, scopeKey, toolName: "explorer", body: "the answer" });
    expect(contents(thread)).toContain("summary of earlier turns");
    expect(contents(thread)).not.toContain("subagent persona");
    expect(roles(thread)).toEqual(["system", "system", "user", "assistant", "user"]);
  });

  it("leaves a compacted-away dispatch alone and still hands back", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.systemMessage("caller persona"));
    thread.push(smoltalk.systemMessage("summary that swallowed the persona"));
    thread.push(smoltalk.assistantMessage("the answer"));
    finishHandoff({ thread, scopeKey, toolName: "explorer", body: "the answer" });
    expect(roles(thread)).toEqual(["system", "system", "assistant", "user"]);
  });

  it("nests: the inner dispatch's persona goes with the inner hand-back", () => {
    const outer = handoffScopeKey("outerAgent", "call-o");
    const inner = handoffScopeKey("subagent", "call-i");
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.enterHandoffScope(outer);
    thread.push(smoltalk.systemMessage("outer persona"));
    thread.enterHandoffScope(inner);
    thread.push(smoltalk.systemMessage("inner persona"));
    thread.push(smoltalk.assistantMessage("inner answer"));
    thread.exitHandoffScope();
    finishHandoff({ thread, scopeKey: inner, toolName: "subagent", body: "inner answer" });
    expect(contents(thread)).toContain("outer persona");
    expect(contents(thread)).not.toContain("inner persona");
    thread.push(smoltalk.assistantMessage("outer answer"));
    thread.exitHandoffScope();
    finishHandoff({ thread, scopeKey: outer, toolName: "outerAgent", body: "outer answer" });
    expect(roles(thread)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });
});

describe("finishStoppedHandoff", () => {
  it("strips the same way and says the body stopped", () => {
    const thread = threadAfterBody();
    finishStoppedHandoff({ thread, scopeKey, toolName: "explorer", reason: "provider timeout" });
    expect(contents(thread)).not.toContain("subagent persona");
    expect(contents(thread).at(-1)).toContain(
      "explorer stopped before finishing: provider timeout",
    );
  });
});

describe("stripHandoffSystemMessages", () => {
  it("removes the body's system messages without a resume message, for a cancelled dispatch", () => {
    const thread = threadAfterBody();
    stripHandoffSystemMessages(thread, scopeKey);
    expect(contents(thread)).not.toContain("subagent persona");
    expect(roles(thread)).toEqual(["system", "user", "user", "assistant"]);
  });
});

describe("message text", () => {
  it("names the tool in every message", () => {
    expect(handoffNotAloneMessage("explorer")).toContain("explorer");
    expect(handoffNotAloneMessage("explorer")).toContain("only tool call");
    expect(handoffScopeKey("explorer", "c1")).toBe("explorer:c1");
    expect(handoffResumeText("explorer", "x")).toBe(
      "[explorer finished. x]\nContinue with the user's request.",
    );
  });
});
