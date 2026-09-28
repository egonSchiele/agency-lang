import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { MessageThread } from "./state/messageThread.js";
import { z } from "zod";
import { StateStack } from "./state/stateStack.js";
import { success, failure } from "./result.js";
import {
  answerValueOf,
  applyEndTurnDecision,
  closeHandoff,
  decideEndTurn,
  endThreadWithAnswer,
  handoffStoppedText,
  type EndTurnDecision,
  type TurnMark,
  type TurnMarks,
  dropHandoffToolCall,
  finishHandoff,
  finishStoppedHandoff,
  handoffNotStartedMessage,
  handoffResumeText,
  handoffScopeKey,
  stripHandoffSystemMessages,
  tooManyHandoffsMessage,
} from "./handoff.js";

const toolCall = () => new smoltalk.ToolCall("call-1", "explorer", { question: "why" });
const sibling = () => new smoltalk.ToolCall("call-2", "updateStatus", { status: "exploring" });
const explorerCall = { index: 0, id: "call-1", name: "explorer" };
// The key a top-level dispatch of `explorer` gets: depth 0, no scope open.
const scopeKey = handoffScopeKey(new MessageThread(), "explorer", "call-1");

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
    dropHandoffToolCall(thread, explorerCall);
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
    dropHandoffToolCall(thread, explorerCall);
    expect(roles(thread)).toEqual(["user"]);
  });

  it("keeps a sibling's call and its tool result", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(
      smoltalk.assistantMessage("Exploring.", { toolCalls: [sibling(), toolCall()] }),
      "main",
    );
    thread.push(smoltalk.toolMessage("ok", { tool_call_id: "call-2", name: "updateStatus" }));
    thread.push(smoltalk.userMessage("guard feedback"));
    dropHandoffToolCall(thread, { ...explorerCall, index: 1 });
    expect(roles(thread)).toEqual(["user", "assistant", "tool", "user"]);
    const carrier = thread.getMessages()[1] as smoltalk.AssistantMessage;
    expect(carrier.content).toBe("Exploring.");
    expect(carrier.toolCalls?.map((call) => call.id)).toEqual(["call-2"]);
    expect(thread.labelAt(1)).toBe("main");
  });

  it("removes a message that was only the call when feedback follows it", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.push(smoltalk.assistantMessage(null, { toolCalls: [toolCall()] }));
    thread.push(smoltalk.userMessage("guard feedback"));
    dropHandoffToolCall(thread, explorerCall);
    expect(roles(thread)).toEqual(["user", "user"]);
  });

  it("refuses a thread with no assistant message", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    expect(() => dropHandoffToolCall(thread, explorerCall)).toThrow(/assistant/);
  });

  it("refuses a call that is not at the given position", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.assistantMessage(null, { toolCalls: [sibling(), toolCall()] }));
    expect(() => dropHandoffToolCall(thread, explorerCall)).toThrow(/explorer/);
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
    const second = handoffScopeKey(thread, "explorer", "call-2");
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
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    const outer = handoffScopeKey(thread, "outerAgent", "call-o");
    thread.enterHandoffScope(outer);
    thread.push(smoltalk.systemMessage("outer persona"));
    const inner = handoffScopeKey(thread, "subagent", "call-i");
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

  it("keeps a handoff nested inside itself apart when the provider sends no call ids", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    const outer = handoffScopeKey(thread, "subagent", "");
    thread.enterHandoffScope(outer);
    thread.push(smoltalk.systemMessage("outer persona"));
    const inner = handoffScopeKey(thread, "subagent", "");
    expect(inner).not.toBe(outer);
    thread.enterHandoffScope(inner);
    thread.push(smoltalk.systemMessage("inner persona"));
    thread.exitHandoffScope();
    expect(handoffScopeKey(thread, "subagent", "")).toBe(inner);
    finishHandoff({ thread, scopeKey: inner, toolName: "subagent", body: "inner answer" });
    expect(contents(thread)).toContain("outer persona");
    expect(contents(thread)).not.toContain("inner persona");
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
    expect(tooManyHandoffsMessage("explorer", ["explorer", "oracle"])).toContain(
      "explorer was not run. explorer and oracle were called in the same response",
    );
    expect(tooManyHandoffsMessage("explorer", ["explorer", "oracle", "coder"])).toContain(
      "explorer, oracle, and coder were called",
    );
    expect(tooManyHandoffsMessage("explorer", ["explorer", "explorer"])).toContain(
      "It was called 2 times in this response",
    );
    expect(handoffNotStartedMessage("explorer", "cost limit reached")).toBe(
      "Error: explorer was not run. The run stopped before it could start: cost limit reached",
    );
    expect(handoffScopeKey(new MessageThread(), "explorer", "c1")).toBe("explorer:c1:0");
    expect(handoffResumeText("explorer", "x")).toBe(
      "[explorer finished. x]\nContinue with the user's request.",
    );
  });
});

// --- Ending the turn from a tool -------------------------------------------

const noMarks: TurnMarks = { endTurn: false, scope: "llm", message: null };
const mark = (overrides: Partial<TurnMark>): TurnMark => ({
  toolName: "tool",
  isHandoff: false,
  endTurn: true,
  scope: "llm",
  message: null,
  value: "answer",
  deferredHandBack: null,
  ...overrides,
});
const collectWarnings = () => {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
};

describe("answerValueOf", () => {
  it("unwraps a success and never sees the placeholder", () => {
    expect(answerValueOf(success("x"))).toBe("x");
    expect(answerValueOf("x")).toBe("x");
    expect(answerValueOf(null)).toBeNull();
    expect(answerValueOf(undefined)).toBeNull();
    expect(answerValueOf(success(undefined))).toBeNull();
  });

  it("passes a failure through", () => {
    const f = failure("boom");
    expect(answerValueOf(f)).toBe(f);
  });
});

describe("closeHandoff", () => {
  const threadWithPersona = () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("hello"));
    thread.enterHandoffScope(scopeKey);
    thread.push(smoltalk.systemMessage("persona"));
    thread.exitHandoffScope();
    return thread;
  };
  const close = (outcome: Parameters<typeof closeHandoff>[0]["outcome"], marks = noMarks) => {
    const thread = threadWithPersona();
    const { warnings, warn } = collectWarnings();
    const deferred = closeHandoff({ thread, scopeKey, toolName: "explorer", outcome, marks, warn });
    return { thread, deferred, warnings };
  };

  it("pushes the default resume text on success and strips the persona", () => {
    const { thread, deferred } = close({ kind: "success", body: "done" });
    expect(deferred).toBeNull();
    expect(roles(thread)).toEqual(["user", "user"]);
    expect(contents(thread)[1]).toBe(handoffResumeText("explorer", "done"));
  });

  it("pushes the custom text on success and on failure", () => {
    const marks = { ...noMarks, message: "Custom." };
    expect(contents(close({ kind: "success", body: "done" }, marks).thread)[1]).toBe("Custom.");
    expect(contents(close({ kind: "stopped", reason: "boom" }, marks).thread)[1]).toBe("Custom.");
  });

  it("pushes the stopped text by default on failure", () => {
    const { thread } = close({ kind: "stopped", reason: "boom" });
    expect(contents(thread)[1]).toBe(handoffStoppedText("explorer", "boom"));
  });

  it("keeps the rejection text and warns about a custom message", () => {
    const marks = { ...noMarks, message: "Custom." };
    const { thread, warnings } = close(
      { kind: "rejected", body: "Tool call rejected: no." },
      marks,
    );
    expect(contents(thread)[1]).toBe(handoffResumeText("explorer", "Tool call rejected: no."));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("rejected");
  });

  it("ignores an empty message with a warning", () => {
    const { thread, warnings } = close(
      { kind: "success", body: "done" },
      { ...noMarks, message: "" },
    );
    expect(contents(thread)[1]).toBe(handoffResumeText("explorer", "done"));
    expect(warnings[0]).toContain("empty");
  });

  it("defers the hand-back on endTurn, keeping the custom message for a fallback", () => {
    const marks = { endTurn: true, scope: "llm" as const, message: "Custom." };
    const { thread, deferred, warnings } = close({ kind: "success", body: "done" }, marks);
    expect(roles(thread)).toEqual(["user"]);
    expect(deferred).toEqual({ scopeKey, body: "done", message: "Custom." });
    expect(warnings).toEqual([]);
  });

  it("does not defer a failure that asked to end the turn", () => {
    const marks = { endTurn: true, scope: "llm" as const, message: null };
    const { deferred, thread } = close({ kind: "stopped", reason: "boom" }, marks);
    expect(deferred).toBeNull();
    expect(contents(thread)[1]).toBe(handoffStoppedText("explorer", "boom"));
  });
});

describe("decideEndTurn", () => {
  const decide = (
    marks: Record<number, TurnMark>,
    ranCallIndexes: number[],
    extra: { responseFormat?: unknown; pendingAttachments?: number } = {},
  ) => {
    const { warnings, warn } = collectWarnings();
    const decision = decideEndTurn({
      marks,
      ranCallIndexes,
      responseFormat: extra.responseFormat ?? null,
      pendingAttachments: extra.pendingAttachments ?? 0,
      warn,
    });
    return { decision, warnings };
  };
  const ended = (decision: EndTurnDecision) => decision.kind === "end";

  it("continues with no marks", () => {
    const { decision, warnings } = decide({}, [0]);
    expect(decision).toEqual({ kind: "continue" });
    expect(warnings).toEqual([]);
  });

  it("ends for an ordinary tool that was the round's only call", () => {
    const { decision } = decide({ 0: mark({}) }, [0]);
    expect(decision).toEqual({
      kind: "end",
      callIndex: 0,
      scope: "llm",
      answerText: "answer",
      returnValue: "answer",
    });
  });

  it("drops an ordinary tool's mark when it ran beside another call", () => {
    const { decision, warnings } = decide({ 1: mark({}) }, [0, 1]);
    expect(ended(decision)).toBe(false);
    expect(warnings[0]).toContain("beside other tool calls");
  });

  it("counts a handoff's mark beside another call", () => {
    const { decision } = decide({ 1: mark({ isHandoff: true, scope: "turn" }) }, [0, 1]);
    expect(decision).toMatchObject({ kind: "end", callIndex: 1, scope: "turn" });
  });

  it("drops two ordinary marks with two warnings", () => {
    const { decision, warnings } = decide(
      { 0: mark({ toolName: "a" }), 1: mark({ toolName: "b" }) },
      [0, 1],
    );
    expect(ended(decision)).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it("warns about handBack from an ordinary tool and uses nothing from it", () => {
    const { decision, warnings } = decide(
      { 0: mark({ endTurn: false, message: "m", value: undefined }) },
      [0],
    );
    expect(decision).toEqual({ kind: "continue" });
    expect(warnings[0]).toContain("only a handoff hands back");
  });

  it("falls back while a reply attachment is waiting", () => {
    const { decision, warnings } = decide({ 0: mark({}) }, [0], { pendingAttachments: 1 });
    expect(ended(decision)).toBe(false);
    expect(warnings[0]).toContain("attachment");
  });

  it("falls back on a non-string value, including null", () => {
    expect(ended(decide({ 0: mark({ value: { a: 1 } }) }, [0]).decision)).toBe(false);
    const { decision, warnings } = decide({ 0: mark({ value: null }) }, [0]);
    expect(ended(decision)).toBe(false);
    expect(warnings[0]).toContain("not a string");
  });

  it("ends with the parsed value when it matches the response format", () => {
    const responseFormat = z.object({ response: z.object({ text: z.string() }) });
    const { decision } = decide({ 0: mark({ value: { text: "hi" } }) }, [0], { responseFormat });
    expect(decision).toMatchObject({
      kind: "end",
      returnValue: { text: "hi" },
      answerText: JSON.stringify({ text: "hi" }),
    });
  });

  it("falls back when the value does not match the response format", () => {
    const responseFormat = z.object({ response: z.object({ text: z.string() }) });
    const { decision, warnings } = decide({ 0: mark({ value: { wrong: 1 } }) }, [0], {
      responseFormat,
    });
    expect(ended(decision)).toBe(false);
    expect(warnings[0]).toContain("structured output");
  });

  it("warns that handBack is ignored when the turn ends", () => {
    const { decision, warnings } = decide({ 0: mark({ isHandoff: true, message: "m" }) }, [0]);
    expect(ended(decision)).toBe(true);
    expect(warnings[0]).toContain("the turn ended");
  });
});

describe("endThreadWithAnswer", () => {
  it("replaces a trailing assistant message without tool calls", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    thread.push(smoltalk.assistantMessage(JSON.stringify({ answer: "3 events", done: true })));
    endThreadWithAnswer(thread, "3 events");
    expect(roles(thread)).toEqual(["user", "assistant"]);
    expect(contents(thread)[1]).toBe("3 events");
  });

  it("replaces the caller's leftover text left by dropHandoffToolCall", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    thread.push(smoltalk.assistantMessage("Let me check.", { toolCalls: [toolCall()] }));
    dropHandoffToolCall(thread, explorerCall);
    endThreadWithAnswer(thread, "3 events");
    expect(contents(thread)).toEqual(["q", "3 events"]);
  });

  it("pushes after a tool message", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    thread.push(smoltalk.assistantMessage(null, { toolCalls: [sibling()] }));
    thread.push(smoltalk.toolMessage("ok", { tool_call_id: "call-2", name: "updateStatus" }));
    endThreadWithAnswer(thread, "ok");
    expect(roles(thread)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("pushes after an assistant message that still carries tool calls", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    thread.push(smoltalk.assistantMessage("Checking.", { toolCalls: [sibling()] }));
    endThreadWithAnswer(thread, "ok");
    expect(roles(thread)).toEqual(["user", "assistant", "assistant"]);
  });
});

describe("applyEndTurnDecision", () => {
  const end = (scope: "llm" | "turn"): EndTurnDecision => ({
    kind: "end",
    callIndex: 0,
    scope,
    answerText: "done",
    returnValue: "done",
  });

  it("pushes a deferred hand-back on continue, custom text or default", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    const deferred = { scopeKey, body: "done", message: null };
    applyEndTurnDecision({
      thread,
      decision: { kind: "continue" },
      marks: { 0: mark({ toolName: "explorer", isHandoff: true, deferredHandBack: deferred }) },
      enclosingStack: null,
    });
    expect(contents(thread)[1]).toBe(handoffResumeText("explorer", "done"));
    const custom = new MessageThread();
    applyEndTurnDecision({
      thread: custom,
      decision: { kind: "continue" },
      marks: {
        0: mark({ isHandoff: true, deferredHandBack: { ...deferred, message: "Custom." } }),
      },
      enclosingStack: null,
    });
    expect(contents(custom)).toEqual(["Custom."]);
  });

  it("ends the thread with the answer and does not touch the enclosing stack for scope llm", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    const enclosing = new StateStack();
    const record = applyEndTurnDecision({
      thread,
      decision: end("llm"),
      marks: {},
      enclosingStack: enclosing,
    });
    expect(record).toEqual({ ended: true, returnValue: "done" });
    expect(contents(thread)).toEqual(["q", "done"]);
    expect(enclosing.drainTurnMarks().endTurn).toBe(false);
  });

  it("re-marks the enclosing stack for scope turn", () => {
    const thread = new MessageThread();
    const enclosing = new StateStack();
    applyEndTurnDecision({ thread, decision: end("turn"), marks: {}, enclosingStack: enclosing });
    expect(enclosing.drainTurnMarks()).toEqual({ endTurn: true, scope: "turn", message: null });
  });
});
