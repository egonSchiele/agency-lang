import { describe, it, expect } from "vitest";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import { agency } from "./agency.js";
import type {
  EmbedConfig,
  EmbedResult,
  LLMClient,
  PromptConfig,
} from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";
import { _toolMessage } from "../stdlib/thread.js";

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

class RecordingClient implements LLMClient {
  configs: PromptConfig[] = [];
  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.configs.push(config);
    return {
      success: true,
      value: {
        output: "ok",
        toolCalls: [],
        model: (config as any).model ?? "unknown",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    };
  }
  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const r = await this.text(config);
    if (r.success) yield { type: "text", text: r.value.output } as StreamChunk;
  }
  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    throw new Error("not used");
  }
}

describe("toolMessage forwarding + wire shape", () => {
  it("forwards the seeded tool exchange, id-matched, into the provider request", async () => {
    const ctx = makeCtx();
    const client = new RecordingClient();
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.");
        await runPrompt({
          prompt: "continue",
          messages: threads.getOrCreateActive(),
          clientConfig: {} as any,
        });
      },
    );

    expect(client.configs).toHaveLength(1);
    // PromptConfig.messages (llmClient.ts:25), filled from the thread at
    // prompt.ts:642. The messages arrive as smoltalk Message instances.
    const sent = (client.configs[0] as any).messages.map((m: any) =>
      typeof m.toJSON === "function" ? m.toJSON() : m,
    );

    const asst = sent.find(
      (m: any) => m.role === "assistant" && m.toolCalls?.length,
    );
    expect(asst).toBeDefined();
    expect(asst.toolCalls[0].name).toBe("saveDraft");

    const tool = sent.find((m: any) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(tool.tool_call_id).toBe(asst.toolCalls[0].id);
    expect(tool.content).toBe("Draft saved.");
  });
});
