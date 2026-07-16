import { describe, it, expect } from "vitest";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import { agency } from "./agency.js";
import type { EmbedConfig, EmbedResult, LLMClient, PromptConfig } from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";

/** `llm(label: "...")` is observability-only. The Agency codegen forwards
 *  a call's named options object to `runPrompt` as `clientConfig`
 *  verbatim, so `label` arrives there and MUST be stripped before the
 *  config reaches the provider. These tests drive that exact shape. */

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

function inFrame<T>(
  ctx: RuntimeContext<any>,
  threads: ThreadStore,
  fn: () => Promise<T>,
): Promise<T> {
  return agency.withTestContext({ ctx, stack: ctx.stateStack, threads }, fn);
}

/** Records every PromptConfig the provider is handed, so a leaked
 *  agency-only key is visible. */
class RecordingClient implements LLMClient {
  configs: PromptConfig[] = [];

  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.configs.push(config);
    return {
      success: true,
      value: {
        output: "answer",
        toolCalls: [],
        model: (config as any).model ?? "unknown",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          totalTokens: 2,
        },
        cost: {
          inputCost: 0,
          outputCost: 0,
          totalCost: 0,
          currency: "USD",
        },
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

async function runLabeled(label: string | undefined) {
  const ctx = makeCtx();
  const client = new RecordingClient();
  ctx.setLLMClient(client);
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const thread = new MessageThread();
  await inFrame(ctx, threads, () =>
    runPrompt({
      prompt: "go",
      messages: thread,
      clientConfig: (label === undefined ? {} : { label }) as any,
    }),
  );
  return { client, thread };
}

describe("llm() debug label", () => {
  it("never reaches the provider config", async () => {
    const { client } = await runLabeled("verifier");
    expect(client.configs).toHaveLength(1);
    expect("label" in (client.configs[0] as any)).toBe(false);
  });

  it("labels both the prompt and the completion this call appends", async () => {
    // One llm() call labeling MORE THAN ONE message is intended: the
    // label marks "these messages came from this call".
    const { thread } = await runLabeled("verifier");
    const roles = thread.getMessages().map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(thread.labelAt(0)).toBe("verifier");
    expect(thread.labelAt(1)).toBe("verifier");
  });

  it("leaves messages unlabeled when no label is given", async () => {
    const { thread } = await runLabeled(undefined);
    expect(thread.labelAt(0)).toBe(null);
    expect(thread.labelAt(1)).toBe(null);
  });

  it("keeps labels aligned with messages", async () => {
    const { thread } = await runLabeled("verifier");
    expect(thread.messageLabels).toHaveLength(thread.getMessages().length);
  });
});
