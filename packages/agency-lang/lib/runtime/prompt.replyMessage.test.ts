import { describe, it, expect, vi } from "vitest";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import * as smoltalk from "smoltalk";
import { runInTestContext } from "./asyncContext.js";
import type { EmbedConfig, EmbedResult, LLMClient, PromptConfig } from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";

/** The reply message runPrompt appends must keep everything the completion
 *  carried beyond its text: a reasoning model's thinking, the reply's
 *  usage, and its cost. `lastReply()` in std::thread reads them back. */

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
  });
}

/** A client whose text() returns one fixed completion. The test hands it the
 *  `PromptResult` it should return, so one class covers a well-formed reply
 *  and a reply whose usage/cost is structurally invalid. */
class CannedClient implements LLMClient {
  constructor(private readonly value: PromptResult) {}

  async text(_config: PromptConfig): Promise<Result<PromptResult>> {
    return { success: true, value: this.value };
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const result = await this.text(config);
    if (result.success) {
      yield { type: "text", text: result.value.output } as StreamChunk;
    }
  }

  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    throw new Error("not used");
  }
}

async function runWith(client: LLMClient): Promise<MessageThread> {
  const ctx = makeCtx();
  ctx.setLLMClient(client);
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const thread = new MessageThread();
  vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
  await runInTestContext(ctx, ctx.stateStack, threads, (run) =>
    runPrompt(run, { prompt: "say hi", messages: thread, clientConfig: {} as any }),
  );
  return thread;
}

describe("the reply message carries the completion's extras", () => {
  it("keeps the completion's thinking, usage, and cost on the reply message", async () => {
    const thread = await runWith(
      new CannedClient({
        output: "hi",
        toolCalls: [],
        thinkingBlocks: [{ text: "let me think", signature: "sig" }],
        usage: { inputTokens: 3, outputTokens: 1 },
        cost: { inputCost: 0.1, outputCost: 0.2, totalCost: 0.3, currency: "USD" },
        model: "m",
      }),
    );
    const reply = thread.getMessages().at(-1) as smoltalk.AssistantMessage;
    expect(reply.role).toBe("assistant");
    expect(reply.thinkingBlocks).toEqual([{ text: "let me think", signature: "sig" }]);
    expect(reply.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(reply.cost?.totalCost).toBe(0.3);
  });

  it("drops a completion extra that would not survive a checkpoint round trip", async () => {
    // A structurally invalid cost (missing the fields CostEstimateSchema
    // requires) must not ride on the message: smoltalk's fromJSON validates it
    // on restore/clone and throws, which would make the run unresumable. The
    // reply keeps its text; the bad cost is dropped, the same as before the
    // reply carried cost at all.
    const thread = await runWith(
      new CannedClient({
        output: "hi",
        toolCalls: [],
        cost: { totalCost: 0.3 } as PromptResult["cost"],
        model: "m",
      }),
    );
    const reply = thread.getMessages().at(-1) as smoltalk.AssistantMessage;
    expect(reply.content).toBe("hi");
    expect(reply.cost).toBeUndefined();
    // The clone/restore path (MessageThread.cloneMessages) must not throw.
    expect(() => smoltalk.messageFromJSON(reply.toJSON())).not.toThrow();
  });
});

describe("an OpenRouter reply's servedBy and reasoning", () => {
  const completion: PromptResult = {
    output: "",
    toolCalls: [],
    model: "z-ai/glm-5.3-flash",
    servedBy: "OpenInference",
    reasoning: "Let me search",
  };

  it("logs servedBy and reasoning on the promptCompletion event", async () => {
    const ctx = makeCtx();
    ctx.setLLMClient(new CannedClient(completion));
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const logged = vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
    await runInTestContext(ctx, ctx.stateStack, threads, (run) =>
      runPrompt(run, { prompt: "say hi", messages: new MessageThread(), clientConfig: {} as any }),
    );
    const event = logged.mock.calls[0][0];
    expect(event.completion.servedBy).toBe("OpenInference");
    expect(event.completion.reasoning).toBe("Let me search");
  });

  it("does not put reasoning on the reply message", async () => {
    // Unsigned reasoning on the message would be sent to Anthropic as a
    // thinking block after a model switch, and Anthropic rejects it.
    const thread = await runWith(new CannedClient(completion));
    const reply = (thread.getMessages().at(-1) as smoltalk.AssistantMessage).toJSON();
    expect(JSON.stringify(reply)).not.toContain("Let me search");
    expect(JSON.stringify(reply)).not.toContain("OpenInference");
    expect((reply as any).thinkingBlocks).toBeUndefined();
  });
});
