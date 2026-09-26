import { describe, it, expect, vi } from "vitest";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import * as smoltalk from "smoltalk";
import { agency } from "./agency.js";
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

/** A client whose text() returns a completion with every extra set. */
class ExtrasClient implements LLMClient {
  async text(_config: PromptConfig): Promise<Result<PromptResult>> {
    return {
      success: true,
      value: {
        output: "hi",
        toolCalls: [],
        thinkingBlocks: [{ text: "let me think", signature: "sig" }],
        usage: { inputTokens: 3, outputTokens: 1 },
        cost: { inputCost: 0.1, outputCost: 0.2, totalCost: 0.3, currency: "USD" },
        model: "m",
      },
    };
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const r = await this.text(config);
    if (r.success) {
      yield { type: "text", text: r.value.output } as StreamChunk;
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
  await agency.withTestContext({ ctx, stack: ctx.stateStack, threads }, () =>
    runPrompt({ prompt: "say hi", messages: thread, clientConfig: {} as any }),
  );
  return thread;
}

/** A client whose completion carries a structurally invalid cost (missing
 *  the fields smoltalk's CostEstimateSchema requires) — the kind of shape a
 *  hand-written custom client can return, since PromptResult.cost is typed
 *  but not runtime-checked at the client boundary. */
class MalformedCostClient implements LLMClient {
  async text(_config: PromptConfig): Promise<Result<PromptResult>> {
    return {
      success: true,
      value: {
        output: "hi",
        toolCalls: [],
        cost: { totalCost: 0.3 } as PromptResult["cost"],
        model: "m",
      },
    };
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const r = await this.text(config);
    if (r.success) {
      yield { type: "text", text: r.value.output } as StreamChunk;
    }
  }

  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    throw new Error("not used");
  }
}

describe("the reply message carries the completion's extras", () => {
  it("keeps the completion's thinking, usage, and cost on the reply message", async () => {
    const thread = await runWith(new ExtrasClient());
    const reply = thread.getMessages().at(-1) as smoltalk.AssistantMessage;
    expect(reply.role).toBe("assistant");
    expect(reply.thinkingBlocks).toEqual([{ text: "let me think", signature: "sig" }]);
    expect(reply.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(reply.cost?.totalCost).toBe(0.3);
  });

  it("drops a completion extra that would not survive a checkpoint round trip", async () => {
    // A malformed cost must not ride on the message: smoltalk's fromJSON
    // validates it on restore/clone and throws, which would make the run
    // unresumable. The reply keeps its text; the bad cost is dropped, the
    // same as before the reply carried cost at all.
    const thread = await runWith(new MalformedCostClient());
    const reply = thread.getMessages().at(-1) as smoltalk.AssistantMessage;
    expect(reply.content).toBe("hi");
    expect(reply.cost).toBeUndefined();
    // The clone/restore path (MessageThread.cloneMessages) must not throw.
    expect(() => smoltalk.messageFromJSON(reply.toJSON())).not.toThrow();
  });
});
