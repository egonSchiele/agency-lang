import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type * as smoltalk from "smoltalk";
import { runInTestContext } from "./asyncContext.js";
import type { LLMMock } from "./deterministicClient.js";
import { CUT_OFF_NOTE, DROPPED_TOOL_CALL_NOTE } from "./llmRetry.js";
import { runPrompt } from "./prompt.js";
import { makeCtx, pingTool, RecordingClient } from "./promptTestHelpers.js";
import { isFailure } from "./result.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";

/** A reply the output limit cut off. See "A reply cut off by the output
 *  limit" in docs/dev/agents/tool-loop-guards.md. The resume cases are in
 *  tests/agency-js/cut-off-retry-resume/. */

const EMPTY_CUT_OFF: LLMMock = { return: "", stopReason: "length" };

function setup(mocks: LLMMock[]) {
  const ctx = makeCtx();
  const client = new RecordingClient(mocks);
  ctx.setLLMClient(client);
  vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
  const warn = vi.spyOn(ctx.statelogClient, "warn").mockResolvedValue();
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const { ping, runs } = pingTool();
  return { ctx, client, threads, ping, runs, warn };
}

type Setup = ReturnType<typeof setup>;

function call(
  s: Setup,
  thread: MessageThread,
  responseFormat?: z.ZodType,
  extraConfig: Record<string, unknown> = {},
): Promise<any> {
  return runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
    runPrompt(run, {
      prompt: "go",
      messages: thread,
      responseFormat,
      clientConfig: { tools: [s.ping], maxRepeatedToolCalls: 0, ...extraConfig } as any,
    }),
  );
}

const textOf = (message: smoltalk.Message): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");

const holdsNote = (messages: smoltalk.Message[]): number =>
  messages.filter((message) => textOf(message) === CUT_OFF_NOTE).length;

const holdsEmptyReply = (messages: smoltalk.Message[]): boolean =>
  messages.some(
    (message) =>
      message.role === "assistant" &&
      textOf(message).trim() === "" &&
      ((message as smoltalk.AssistantMessage).toolCalls ?? []).length === 0,
  );

describe("a reply cut off by the output limit", () => {
  it("an empty reply cut off by the length limit is retried, and the next reply is the answer", async () => {
    const s = setup([EMPTY_CUT_OFF, { return: "done" }]);
    const thread = new MessageThread();
    expect(await call(s, thread)).toBe("done");
    expect(s.client.requests).toHaveLength(2);
    const second = s.client.requests[1];
    expect(second.at(-1)!.role).toBe("user");
    expect(textOf(second.at(-1)!)).toBe(CUT_OFF_NOTE);
    expect(holdsEmptyReply(second)).toBe(false);
    expect(holdsEmptyReply(thread.getMessages())).toBe(false);
    expect(holdsNote(thread.getMessages())).toBe(0);
  });

  it("a cut-off empty reply after tool rounds is retried, and the loop keeps running tools", async () => {
    const s = setup([
      { toolCall: { name: "ping" } },
      EMPTY_CUT_OFF,
      { toolCall: { name: "ping" } },
      { return: "ok" },
    ]);
    expect(await call(s, new MessageThread())).toBe("ok");
    expect(s.runs()).toBe(2);
    expect(s.client.requests).toHaveLength(4);
  });

  it("three cut-off empty replies in a row are a failure that names the output limit", async () => {
    const s = setup([EMPTY_CUT_OFF, EMPTY_CUT_OFF, EMPTY_CUT_OFF]);
    const result = await call(s, new MessageThread());
    expect(isFailure(result)).toBe(true);
    expect(result.error).toContain("output limit");
    expect(s.client.requests).toHaveLength(3);
  });

  it("a cut-off reply with text is returned with a warning", async () => {
    const s = setup([{ return: "Partial ans", stopReason: "length" }]);
    expect(await call(s, new MessageThread())).toBe("Partial ans");
    expect(s.client.requests).toHaveLength(1);
    const warnings = s.warn.mock.calls.filter(([event]) => event.warnType === "replyCutOff");
    expect(warnings).toHaveLength(1);
  });

  it("an empty reply that stopped normally is returned without a retry", async () => {
    const s = setup([{ return: "", stopReason: "stop" }]);
    expect(await call(s, new MessageThread())).toBe("");
    expect(s.client.requests).toHaveLength(1);
  });

  it("reports the retry to the onLLMRetry hook with the cutOff reason", async () => {
    const s = setup([EMPTY_CUT_OFF, { return: "done" }]);
    const retries: any[] = [];
    s.ctx.callbacks.onLLMRetry = (data: any) => {
      retries.push(data);
    };
    await call(s, new MessageThread());
    expect(retries).toEqual([
      expect.objectContaining({ reason: "cutOff", attempt: 1, maxRetries: 2 }),
    ]);
  });

  it("a retry of the first request carries the recalled memory facts again", async () => {
    const s = setup([EMPTY_CUT_OFF, { return: "done" }]);
    vi.spyOn(s.ctx, "getActiveMemoryManager").mockReturnValue({
      recallForInjection: async () => "the user likes tea",
      onTurn: async () => {},
      compactIfNeeded: async () => null,
    } as any);
    const thread = new MessageThread();
    expect(await call(s, thread, undefined, { memory: true })).toBe("done");
    const facts = "Relevant context from memory:\nthe user likes tea";
    const factsIn = (messages: smoltalk.Message[]) =>
      messages.filter((message) => textOf(message) === facts).length;
    expect(factsIn(s.client.requests[0])).toBe(1);
    expect(factsIn(s.client.requests[1])).toBe(1);
    expect(factsIn(thread.getMessages())).toBe(0);
  });

  it("an empty cut-off reply in a schema call is retried before validation", async () => {
    const s = setup([EMPTY_CUT_OFF, { return: { a: 1 } }]);
    const result = await call(s, new MessageThread(), z.object({ a: z.number() }));
    expect(result).toEqual({ a: 1 });
    expect(s.client.requests).toHaveLength(2);
  });
});

/** A reply that stopped to call a tool but carried no tool call. A local
 *  model server drops a call it cannot parse and still reports the stop
 *  reason, so the model believes it called a tool and nothing ran. See "A
 *  reply whose tool call was lost" in docs/dev/agents/tool-loop-guards.md. */
const DROPPED_CALL: LLMMock = { return: "", stopReason: "tool_use" };

const holdsDroppedNote = (messages: smoltalk.Message[]): number =>
  messages.filter((message) => textOf(message) === DROPPED_TOOL_CALL_NOTE).length;

describe("a reply whose tool call was lost", () => {
  it("is retried with a note asking for the call again, and the next reply is the answer", async () => {
    const s = setup([DROPPED_CALL, { return: "done" }]);
    const thread = new MessageThread();
    expect(await call(s, thread)).toBe("done");
    expect(s.client.requests).toHaveLength(2);
    const second = s.client.requests[1];
    expect(textOf(second.at(-1)!)).toBe(DROPPED_TOOL_CALL_NOTE);
    expect(holdsNote(second)).toBe(0);
    expect(holdsEmptyReply(second)).toBe(false);
    expect(holdsDroppedNote(thread.getMessages())).toBe(0);
  });

  it("is retried even when the reply has text before the lost call", async () => {
    const s = setup([
      { return: "Let me search for the HTML writer first.", stopReason: "tool_use" },
      { return: "done" },
    ]);
    const thread = new MessageThread();
    expect(await call(s, thread)).toBe("done");
    expect(s.client.requests).toHaveLength(2);
    const texts = thread.getMessages().map(textOf);
    expect(texts).not.toContain("Let me search for the HTML writer first.");
  });

  it("after tool rounds, is retried and the loop keeps running tools", async () => {
    const s = setup([
      { toolCall: { name: "ping" } },
      DROPPED_CALL,
      { toolCall: { name: "ping" } },
      { return: "ok" },
    ]);
    expect(await call(s, new MessageThread())).toBe("ok");
    expect(s.runs()).toBe(2);
    expect(s.client.requests).toHaveLength(4);
  });

  it("three lost calls in a row are a failure that says the calls could not be read", async () => {
    const s = setup([DROPPED_CALL, DROPPED_CALL, DROPPED_CALL]);
    const result = await call(s, new MessageThread());
    expect(isFailure(result)).toBe(true);
    expect(result.error).toContain("could not read");
    expect(s.client.requests).toHaveLength(3);
  });

  it("shares the retry limit with cut-off replies, and the failure names the last reply", async () => {
    const s = setup([EMPTY_CUT_OFF, DROPPED_CALL, DROPPED_CALL]);
    const result = await call(s, new MessageThread());
    expect(isFailure(result)).toBe(true);
    expect(s.client.requests).toHaveLength(3);
    expect(holdsNote(s.client.requests[1])).toBe(1);
    expect(holdsDroppedNote(s.client.requests[2])).toBe(1);
    expect(result.error).toBe(
      "The model stopped to call a tool, but no tool call arrived, and the retries ran out. " +
        "Its server could not read the calls the model wrote.",
    );
  });

  it("a cut-off reply last in the shared limit fails with the output-limit message", async () => {
    const s = setup([DROPPED_CALL, DROPPED_CALL, EMPTY_CUT_OFF]);
    const result = await call(s, new MessageThread());
    expect(isFailure(result)).toBe(true);
    expect(result.error).toBe(
      "The model reached its output limit without writing any text or tool call, and the " +
        "retries ran out. Lower reasoningEffort, or raise maxTokens.",
    );
  });

  it("at the round cap, where the request offers no tools, is the answer and is not retried", async () => {
    const s = setup([
      { toolCall: { name: "ping" } },
      { return: "Here is the answer.", stopReason: "tool_use" },
    ]);
    const result = await call(s, new MessageThread(), undefined, { maxToolCallRounds: 1 });
    expect(result).toBe("Here is the answer.");
    expect(s.client.requests).toHaveLength(2);
    expect(s.client.offered).toEqual([["ping"], []]);
    expect(holdsDroppedNote(s.client.requests[1])).toBe(0);
  });

  it("in a call with no tools, is the answer and is not retried", async () => {
    const s = setup([{ return: "Here is the answer.", stopReason: "tool_use" }]);
    const result = await call(s, new MessageThread(), undefined, { tools: [] });
    expect(result).toBe("Here is the answer.");
    expect(s.client.requests).toHaveLength(1);
  });

  it("reports the retry to the onLLMRetry hook with the droppedToolCall reason", async () => {
    const s = setup([DROPPED_CALL, { return: "done" }]);
    const retries: any[] = [];
    s.ctx.callbacks.onLLMRetry = (data: any) => {
      retries.push(data);
    };
    await call(s, new MessageThread());
    expect(retries).toEqual([
      expect.objectContaining({ reason: "droppedToolCall", attempt: 1, maxRetries: 2 }),
    ]);
  });
});
