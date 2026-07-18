import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as smoltalk from "smoltalk";
import { ToolCall } from "smoltalk";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import { AgencyFunction } from "./agencyFunction.js";
import { agency } from "./agency.js";
import type {
  EmbedConfig,
  EmbedResult,
  LLMClient,
  PromptConfig,
} from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";

/** The observable surface of the saveDraft intrinsic (plan review
 *  findings 1/M1/M3): what the PROVIDER receives (the synthesized tool
 *  definition, keyed by the threaded draftSchema), what the MODEL
 *  receives (the ack tool message, paired by tool_call_id), and what
 *  the TRACE receives (the toolCallStart/toolCall events). None of
 *  these are visible to the .agency fixtures — they only see the
 *  salvaged draft — so this is where a silent seam failure would
 *  otherwise hide (a dropped draftSchema falls back to z.string() and
 *  every fixture stays green). */

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

/** Records every PromptConfig; the FIRST response issues a saveDraft
 *  tool call, later responses answer plainly, ending the loop. */
class ScriptedClient implements LLMClient {
  configs: PromptConfig[] = [];
  constructor(private readonly saveValue: unknown) {}

  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.configs.push(config);
    const first = this.configs.length === 1;
    return {
      success: true,
      value: {
        output: first ? "" : "answer",
        toolCalls: first
          ? [new ToolCall("mock-tool-0", "saveDraft", { value: this.saveValue })]
          : [],
        model: (config as any).model ?? "unknown",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          totalTokens: 2,
        },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      } as any,
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

function stdlibShapedSaveDraft(): AgencyFunction {
  return new AgencyFunction({
    name: "saveDraft",
    module: "stdlib/index.agency",
    fn: () => null,
    params: [
      {
        name: "value",
        hasDefault: false,
        defaultValue: undefined,
        variadic: false,
      } as any,
    ],
    toolDefinition: {
      name: "saveDraft",
      description: "the def's own description",
      schema: z.object({ value: z.any() }),
    },
  });
}

async function runSaveDraftPrompt(opts: {
  draftSchema: unknown;
  save: unknown;
}) {
  const ctx = makeCtx();
  const client = new ScriptedClient(opts.save);
  ctx.setLLMClient(client);
  const statelogEvents: { kind: string; payload: any }[] = [];
  const sc = ctx.statelogClient as any;
  sc.toolCallStart = (payload: any) =>
    statelogEvents.push({ kind: "toolCallStart", payload });
  sc.toolCall = (payload: any) =>
    statelogEvents.push({ kind: "toolCall", payload });
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const thread = new MessageThread();
  // The frame a real caller (a function/node/guard-block scope) would
  // own. runPrompt pushes ITS OWN frame on top; setSavedDraft's
  // callerFrame() write must land here — the frame-math the spec
  // correction pinned.
  const ownerFrame = ctx.stateStack.getNewState();
  await inFrame(ctx, threads, () =>
    runPrompt({
      prompt: "go",
      messages: thread,
      clientConfig: { tools: [stdlibShapedSaveDraft()] } as any,
      draftSchema: opts.draftSchema,
    }),
  );
  return {
    providerConfigs: client.configs,
    messages: thread.getMessages() as any[],
    statelogEvents,
    ownerFrame,
  };
}

function saveDraftDefIn(config: PromptConfig): any {
  return (config as any).tools.find((t: any) => t.name === "saveDraft");
}

describe("saveDraft intrinsic — the observable surface", () => {
  it("the provider-bound schema uses the threaded draftSchema, not the fallback", async () => {
    const { providerConfigs } = await runSaveDraftPrompt({
      draftSchema: z.number(),
      save: 3,
    });
    const def = saveDraftDefIn(providerConfigs[0]);
    expect(def).toBeDefined();
    // The value slot must be the THREADED schema: a number passes, a
    // string fails. With the fallback this assertion inverts — which
    // is exactly the silent failure this test exists to catch.
    expect(def.schema.shape.value.safeParse(3).success).toBe(true);
    expect(def.schema.shape.value.safeParse("x").success).toBe(false);
  });

  it("a structured draftSchema reaches the provider too (object, not just primitive)", async () => {
    const reportSchema = z.object({ title: z.string() });
    const { providerConfigs } = await runSaveDraftPrompt({
      draftSchema: reportSchema,
      save: { title: "t" },
    });
    const def = saveDraftDefIn(providerConfigs[0]);
    expect(def.schema.shape.value.safeParse({ title: "t" }).success).toBe(true);
    expect(def.schema.shape.value.safeParse("flat string").success).toBe(false);
  });

  it("without draftSchema the provider-bound value schema is the string fallback", async () => {
    const { providerConfigs } = await runSaveDraftPrompt({
      draftSchema: undefined,
      save: "x",
    });
    const def = saveDraftDefIn(providerConfigs[0]);
    expect(def.schema.shape.value.safeParse("x").success).toBe(true);
    expect(def.schema.shape.value.safeParse(3).success).toBe(false);
    // The synthesized definition replaced the def's own.
    expect(def.description).toMatch(/best-so-far/);
  });

  it("the draft files on the CALLER's frame (the owner scope, not runPrompt's own)", async () => {
    const { ownerFrame } = await runSaveDraftPrompt({
      draftSchema: undefined,
      save: "hello",
    });
    expect(ownerFrame.savedDraft).toEqual({ value: "hello" });
  });

  it("the model receives the ack as a paired tool message", async () => {
    const { messages } = await runSaveDraftPrompt({
      draftSchema: undefined,
      save: "hello",
    });
    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe("Draft saved (5 characters).");
    // Pairing: the result must carry the SAME id the tool call was
    // issued with, or real providers reject the round.
    expect(toolMsg.tool_call_id).toBe("mock-tool-0");
  });

  it("the trace receives toolCallStart and toolCall events for the intrinsic", async () => {
    const { statelogEvents } = await runSaveDraftPrompt({
      draftSchema: undefined,
      save: "hello",
    });
    const start = statelogEvents.find((e) => e.kind === "toolCallStart");
    const end = statelogEvents.find((e) => e.kind === "toolCall");
    expect(start?.payload.toolName).toBe("saveDraft");
    expect(start?.payload.args).toEqual({ value: "hello" });
    expect(end?.payload.output).toBe("Draft saved (5 characters).");
  });
});
