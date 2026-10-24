import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import { AgencyFunction } from "./agencyFunction.js";
import { runInTestContext, type Run } from "./asyncContext.js";
import { DeterministicClient, type LLMMock } from "./deterministicClient.js";
import type { EmbedConfig, EmbedResult, LLMClient, PromptConfig } from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";
import { _setLlmOptions } from "../stdlib/llm.js";

/** The round cap, `maxToolCallRounds`: where its value comes from, and
 *  what happens at the cap. See "The round cap" in
 *  docs/dev/agents/tool-loop-guards.md. */

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

/** A deterministic client that also records which tools, and which
 *  hosted tools, each request offered, so a test can see the request
 *  after the cap carry none of either. */
class RecordingClient implements LLMClient {
  readonly offered: string[][] = [];
  readonly hosted: string[][] = [];
  private readonly inner: DeterministicClient;

  constructor(mocks: LLMMock[]) {
    this.inner = new DeterministicClient(mocks);
  }

  private record(config: PromptConfig): void {
    this.offered.push((config.tools ?? []).map((tool) => tool.name));
    this.hosted.push(config.hostedTools ?? []);
  }

  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.record(config);
    return this.inner.text(config);
  }

  textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    this.record(config);
    return this.inner.textStream(config);
  }

  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    return { success: false, error: "not used" };
  }
}

/** A tool that counts how many times it ran. */
function pingTool(): { ping: AgencyFunction; runs: () => number } {
  let count = 0;
  const ping = new AgencyFunction({
    name: "ping",
    module: "test.agency",
    fn: () => {
      count += 1;
      return "pong";
    },
    params: [],
    toolDefinition: { name: "ping", description: "Returns pong.", schema: z.object({}) },
  });
  return { ping, runs: () => count };
}

/** `n` replies that each call `ping`, then a text reply. */
function pingMocks(n: number): LLMMock[] {
  const calls: LLMMock[] = Array.from({ length: n }, () => ({
    toolCall: { name: "ping", args: {} },
  }));
  return [...calls, { return: "done" }];
}

const REFUSAL = /Maximum number of tool call rounds \((\d+)\) exceeded/;

type Setup = {
  ctx: RuntimeContext<any>;
  client: RecordingClient;
  threads: ThreadStore;
  ping: AgencyFunction;
  runs: () => number;
};

function setup(mocks: LLMMock[]): Setup {
  const ctx = makeCtx();
  const client = new RecordingClient(mocks);
  ctx.setLLMClient(client);
  vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const { ping, runs } = pingTool();
  return { ctx, client, threads, ping, runs };
}

/** One `llm()` call: `perCall` is the call's own option, `baked` the value
 *  the codegen passes from agency.json. */
function call(
  run: Run,
  s: Setup,
  thread: MessageThread,
  opts: { perCall?: number; baked: number },
): Promise<any> {
  return runPrompt(run, {
    prompt: "call ping",
    messages: thread,
    // The repeat guard is off: every ping here is the same call with the
    // same result, and the cap is what is under test.
    clientConfig: {
      tools: [s.ping],
      hostedTools: ["web_search"],
      maxToolCallRounds: opts.perCall,
      maxRepeatedToolCalls: 0,
    } as any,
    maxToolCallRounds: opts.baked,
  });
}

function refusals(thread: MessageThread): string[] {
  return thread
    .getMessages()
    .filter((m) => m.role === "tool" && REFUSAL.test(String(m.content)))
    .map((m) => String(m.content));
}

describe("the round cap", () => {
  it("refuses the fourth round at a cap of 3, names the cap, and offers no tools after it, hosted ones included", async () => {
    const s = setup(pingMocks(4));
    const thread = new MessageThread();
    const result = await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
      call(run, s, thread, { perCall: 3, baked: 10 }),
    );
    expect(result).toBe("done");
    expect(s.runs()).toBe(3);
    const refused = refusals(thread);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/\(3\) exceeded/);
    expect(refused[0]).toMatch(/Write your answer now/);
    // Five requests: the first, one after each of the three rounds that
    // ran, and one after the refused round. Only the last carries no tools.
    expect(s.client.offered).toEqual([["ping"], ["ping"], ["ping"], ["ping"], []]);
    const search = ["web_search"];
    expect(s.client.hosted).toEqual([search, search, search, search, []]);
  });

  it("counts rounds per llm() call: a second call in the same frame gets its own cap", async () => {
    const s = setup([...pingMocks(4), ...pingMocks(4)]);
    const first = new MessageThread();
    const second = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, async (run) => {
      await call(run, s, first, { perCall: 3, baked: 10 });
      await call(run, s, second, { perCall: 3, baked: 10 });
    });
    expect(s.runs()).toBe(6);
    expect(refusals(first)).toHaveLength(1);
    expect(refusals(second)).toHaveLength(1);
  });

  it("the call's own value and a branch default are both ceilings: the smaller wins", async () => {
    // The trace case: the agent's branch-wide 50 must not replace the
    // researcher's 30.
    const lower = setup(pingMocks(4));
    const lowerThread = new MessageThread();
    await runInTestContext(lower.ctx, lower.ctx.stateStack, lower.threads, async (run) => {
      _setLlmOptions({ maxToolCallRounds: 10 });
      await call(run, lower, lowerThread, { perCall: 3, baked: 10 });
    });
    expect(lower.runs()).toBe(3);
    expect(refusals(lowerThread)[0]).toMatch(/\(3\) exceeded/);
    // The flag case: --max-tool-call-rounds 2 must bound a call that asks
    // for more.
    const higher = setup(pingMocks(4));
    const higherThread = new MessageThread();
    await runInTestContext(higher.ctx, higher.ctx.stateStack, higher.threads, async (run) => {
      _setLlmOptions({ maxToolCallRounds: 2 });
      await call(run, higher, higherThread, { perCall: 10, baked: 10 });
    });
    expect(higher.runs()).toBe(2);
    expect(refusals(higherThread)[0]).toMatch(/\(2\) exceeded/);
  });

  it("a branch default beats the baked value", async () => {
    const s = setup(pingMocks(4));
    const thread = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, async (run) => {
      _setLlmOptions({ maxToolCallRounds: 2 });
      await call(run, s, thread, { baked: 10 });
    });
    expect(s.runs()).toBe(2);
    expect(refusals(thread)[0]).toMatch(/\(2\) exceeded/);
  });

  it("the baked value applies when nothing else is set", async () => {
    const s = setup(pingMocks(4));
    const thread = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
      call(run, s, thread, { baked: 10 }),
    );
    expect(s.runs()).toBe(4);
    expect(refusals(thread)).toHaveLength(0);
  });
});
