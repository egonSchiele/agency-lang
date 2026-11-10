import { describe, it, expect, vi } from "vitest";
import * as smoltalk from "smoltalk";
import { runInTestContext } from "./asyncContext.js";
import type { LLMMock } from "./deterministicClient.js";
import { buildCompactionPrompt } from "./memory/compaction.js";
import { runPrompt } from "./prompt.js";
import { makeCtx, pingTool, RecordingClient } from "./promptTestHelpers.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";

/** A reply's reasoning record rides on the reply message, so smoltalk can
 *  send it back to the model that produced it. Agency only keeps the
 *  record; smoltalk decides which request receives it. See "Reasoning sent
 *  back to the model" in docs/dev/llm/smoltalk.md. The resume case is in
 *  tests/agency-js/reasoning-record-resume/. */

function setup(mocks: LLMMock[]) {
  const ctx = makeCtx();
  const client = new RecordingClient(mocks);
  ctx.setLLMClient(client);
  vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const { ping } = pingTool();
  return { ctx, client, threads, ping };
}

type Setup = ReturnType<typeof setup>;

function call(s: Setup, thread: MessageThread, extraConfig: Record<string, unknown> = {}) {
  return runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
    runPrompt(run, {
      prompt: "go",
      messages: thread,
      clientConfig: { tools: [s.ping], maxRepeatedToolCalls: 0, ...extraConfig } as any,
    }),
  );
}

/** The reasoning text of each assistant message a request carried. */
const reasoningIn = (messages: smoltalk.Message[]) =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => (message as smoltalk.AssistantMessage).reasoning?.text);

describe("reasoning records on the thread", () => {
  it("the next request carries the reply's reasoning record", async () => {
    const s = setup([{ toolCall: { name: "ping" }, reasoning: "plan" }, { return: "ok" }]);
    expect(await call(s, new MessageThread())).toBe("ok");
    expect(reasoningIn(s.client.requests[1])).toEqual(["plan"]);
  });

  it("a model switch leaves the record on the message for smoltalk to filter", async () => {
    // smoltalk drops a record whose model differs from the request's. This
    // test only pins that Agency keeps the record for it to decide on.
    const s = setup([{ return: "first", reasoning: "plan" }, { return: "second" }]);
    const thread = new MessageThread();
    await call(s, thread, { model: "model-a" });
    await call(s, thread, { model: "model-b" });
    expect(reasoningIn(s.client.requests[1])).toEqual(["plan"]);
  });

  it("compaction leaves reasoning out of the summary, and kept messages keep their records", async () => {
    const record: smoltalk.ReasoningRecord = {
      provider: "openrouter",
      model: "m",
      text: "secret plan",
      format: "reasoning",
    };
    const older = [
      smoltalk.userMessage("first question"),
      smoltalk.assistantMessage("first answer", { reasoning: record }),
    ];
    // Passes before any change: the summary prompt reads content only. It
    // guards against a later change that serializes whole messages.
    expect(buildCompactionPrompt(older)).not.toContain("secret plan");

    const s = setup([{ return: "ok" }]);
    const thread = new MessageThread();
    for (const message of older) {
      thread.push(message);
    }
    vi.spyOn(s.ctx, "getActiveMemoryManager").mockReturnValue({
      onTurn: async () => {},
      // Summarize the first message and keep the rest.
      compactIfNeeded: async (_run: unknown, messages: smoltalk.Message[]) => ({
        systemPrefixIndices: [],
        summaryMessageContent: "summary",
        keptIndices: messages.map((_message, index) => index).slice(1),
        tailIndices: [],
      }),
    } as any);
    await call(s, thread);
    expect(thread.getMessages().some((message) => message.content === "summary")).toBe(true);
    const kept = thread
      .getMessages()
      .find((message) => message.content === "first answer") as smoltalk.AssistantMessage;
    expect(kept.reasoning).toEqual(record);
  });
});
