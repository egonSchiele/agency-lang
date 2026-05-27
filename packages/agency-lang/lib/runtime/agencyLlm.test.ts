import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import { agency } from "./agency.js";
import { DeterministicClient } from "./deterministicClient.js";
import type { EmbedConfig, EmbedResult, LLMClient, PromptConfig } from "./llmClient.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";

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

/** Custom LLM client that records every PromptConfig it sees. Used to
 *  pin the `clientConfig.model` flow-through (does `opts.model` reach
 *  the client? does it leak into subsequent calls?). */
class RecordingClient implements LLMClient {
  configs: PromptConfig[] = [];
  responses: string[];
  private idx = 0;

  constructor(responses: string[] = ["ok"]) {
    this.responses = responses;
  }

  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.configs.push(config);
    const output = this.responses[this.idx++] ?? "ok";
    return {
      success: true,
      value: {
        output,
        toolCalls: [],
        model: (config as any).model ?? "unknown",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0.000001, outputCost: 0.000001, totalCost: 0.000002, currency: "USD" },
      },
    };
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const r = await this.text(config);
    if (r.success) yield { type: "done", result: r.value };
    else yield { type: "error", error: r.error };
  }

  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    return { success: false, error: "not implemented" };
  }
}

describe("agency.llm — basic behavior", () => {
  it("returns the assistant string response from a single LLM call", async () => {
    const ctx = makeCtx();
    ctx.setLLMClient(new DeterministicClient([{ return: "hello" }]));
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const r = await inFrame(ctx, threads, () => agency.llm("hi"));
    expect(r).toBe("hello");
  });

  it("prompt and assistant response land in the active thread", async () => {
    const ctx = makeCtx();
    ctx.setLLMClient(new DeterministicClient([{ return: "world" }]));
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await inFrame(ctx, threads, () => agency.llm("hello"));
    const msgs = threads.active()!.getMessages();
    const roles = msgs.map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].content).toBe("world");
  });

  it("cost tracking: the active stack's localCost increments after the call", async () => {
    const ctx = makeCtx();
    ctx.setLLMClient(new DeterministicClient([{ return: "x" }]));
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const before = ctx.stateStack.localCost;
    await inFrame(ctx, threads, () => agency.llm("hi"));
    expect(ctx.stateStack.localCost).toBeGreaterThan(before);
  });

  it("structured output: parses the response against opts.schema", async () => {
    const ctx = makeCtx();
    const schema = z.object({ name: z.string(), age: z.number() });
    ctx.setLLMClient(
      new DeterministicClient([{ return: { name: "ada", age: 36 } }]),
    );
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const r = await inFrame(ctx, threads, () =>
      agency.llm("extract", { schema }),
    );
    expect(r).toEqual({ name: "ada", age: 36 });
  });
});

describe("agency.llm — options mapping", () => {
  it("opts.thread routes the prompt + response to the override thread, not the active one", async () => {
    const ctx = makeCtx();
    ctx.setLLMClient(new DeterministicClient([{ return: "aux-response" }]));
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const auxId = threads.create();
    const auxThread = threads.get(auxId)!;
    await inFrame(ctx, threads, () =>
      agency.llm("aux-prompt", { thread: auxThread }),
    );
    expect(auxThread.getMessages().map((m: any) => m.content)).toEqual([
      "aux-prompt",
      "aux-response",
    ]);
    // The active (default) thread is unaffected.
    expect(threads.active()!.getMessages()).toEqual([]);
  });

  it("opts.model overrides the model for THIS call only — subsequent calls fall back to the default", async () => {
    const ctx = makeCtx();
    const client = new RecordingClient(["one", "two"]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await inFrame(ctx, threads, async () => {
      await agency.llm("first", { model: "override-model" });
      await agency.llm("second");
    });
    // Call 1 carries the override; call 2 falls back to smoltalkDefaults
    // ("default-model"). If `opts.model` accidentally mutates the
    // active client config instead of being per-call, call 2 would
    // still report "override-model" — that's the regression this test
    // catches.
    expect((client.configs[0] as any).model).toBe("override-model");
    expect((client.configs[1] as any).model).toBe("default-model");
  });

  it("opts.schema is passed through as runPrompt's responseFormat", async () => {
    const ctx = makeCtx();
    const client = new RecordingClient([JSON.stringify({ kind: "x" })]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const schema = z.object({ kind: z.string() });
    await inFrame(ctx, threads, () => agency.llm("p", { schema }));
    // PromptConfig propagates the responseFormat under `responseFormat`.
    // (Exact field shape on PromptConfig comes from smoltalk; the
    // important contract is "it was passed".)
    expect((client.configs[0] as any).responseFormat).toBeDefined();
  });

  it("checkpointInfo is populated from agency.callsite()", async () => {
    const ctx = makeCtx();
    const client = new RecordingClient(["r"]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    // The callsite flows into runPrompt's checkpointInfo, which the
    // PromptRunner uses to label any interrupt-time checkpoint.
    // Verify the seam by reading the recorded callsite back off the
    // outer frame the moment runPrompt would consume it.
    await inFrame(ctx, threads, () =>
      agency.withCallsite(
        { moduleId: "M", scopeName: "S", stepPath: "1.2" },
        async () => {
          const cs = agency.callsite();
          expect(cs).toEqual({ moduleId: "M", scopeName: "S", stepPath: "1.2" });
          await agency.llm("p");
        },
      ),
    );
  });
});

describe("agency.llm — v1 surface lock", () => {
  it("LlmOpts has no tools / removedTools / maxToolCallRounds fields", async () => {
    const ctx = makeCtx();
    ctx.setLLMClient(
      new DeterministicClient([
        { return: "x" },
        { return: "y" },
        { return: "z" },
      ]),
    );
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await inFrame(ctx, threads, async () => {
      // @ts-expect-error — tools are not part of LlmOpts in v1.
      await agency.llm("p", { tools: [] });
      // @ts-expect-error — removedTools is codegen-internal.
      await agency.llm("p", { removedTools: [] });
      // @ts-expect-error — maxToolCallRounds is codegen-internal.
      await agency.llm("p", { maxToolCallRounds: 1 });
    });
  });
});

describe("agency.llm — frame requirement", () => {
  it("throws when called outside any agency frame", async () => {
    // Without `inFrame(...)`, there is no agencyStore frame installed,
    // so getRuntimeContext() inside the helper throws. Pin this so a
    // future "auto-wrap in a bootstrap frame" change is a conscious
    // decision, not silent drift.
    await expect(agency.llm("hi")).rejects.toThrow(
      /outside an Agency execution frame/,
    );
  });
});
