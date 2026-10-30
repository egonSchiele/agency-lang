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
import { _endTurn } from "../stdlib/thread.js";
import * as smoltalk from "smoltalk";
import { AgencyCancelledError } from "./errors.js";
import { interrupt } from "./interrupts.js";
import { DEFAULT_ROUND_WARNING, type WarnAtRoundsLeft } from "./roundWarning.js";
import { labelOf } from "./state/messageMetadata.js";

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
  /** The messages each request carried, copied when it was sent. */
  readonly requests: smoltalk.Message[][] = [];
  private readonly inner: DeterministicClient;

  constructor(mocks: LLMMock[]) {
    this.inner = new DeterministicClient(mocks);
  }

  private record(config: PromptConfig): void {
    this.offered.push((config.tools ?? []).map((tool) => tool.name));
    this.hosted.push(config.hostedTools ?? []);
    this.requests.push([...config.messages]);
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

const REFUSAL = /This request's budget of (\d+) tool rounds is used up/;

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
  opts: { perCall?: number; baked: number; warnAtRoundsLeft?: WarnAtRoundsLeft },
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
      warnAtRoundsLeft: opts.warnAtRoundsLeft,
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
  it("offers no tools after the third round at a cap of 3, refuses a fourth, and names the cap", async () => {
    const s = setup(pingMocks(4));
    const thread = new MessageThread();
    const result = await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
      call(run, s, thread, { perCall: 3, baked: 10 }),
    );
    expect(result).toBe("done");
    expect(s.runs()).toBe(3);
    const refused = refusals(thread);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/budget of 3 tool rounds/);
    expect(refused[0]).toMatch(/Write your answer now/);
    // Five requests: the first, one after each of the three rounds that
    // ran, and one after the refused round. The request after the third
    // round offers no tools; the mock calls ping anyway, which is refused.
    expect(s.client.offered).toEqual([["ping"], ["ping"], ["ping"], [], []]);
    const search = ["web_search"];
    expect(s.client.hosted).toEqual([search, search, search, [], []]);
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
    expect(refusals(lowerThread)[0]).toMatch(/budget of 3 tool rounds/);
    // The flag case: --max-tool-call-rounds 2 must bound a call that asks
    // for more.
    const higher = setup(pingMocks(4));
    const higherThread = new MessageThread();
    await runInTestContext(higher.ctx, higher.ctx.stateStack, higher.threads, async (run) => {
      _setLlmOptions({ maxToolCallRounds: 2 });
      await call(run, higher, higherThread, { perCall: 10, baked: 10 });
    });
    expect(higher.runs()).toBe(2);
    expect(refusals(higherThread)[0]).toMatch(/budget of 2 tool rounds/);
  });

  it("a branch default beats the baked value", async () => {
    const s = setup(pingMocks(4));
    const thread = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, async (run) => {
      _setLlmOptions({ maxToolCallRounds: 2 });
      await call(run, s, thread, { baked: 10 });
    });
    expect(s.runs()).toBe(2);
    expect(refusals(thread)[0]).toMatch(/budget of 2 tool rounds/);
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

/** A tool named `name` that runs `fn`, for the ways a call can end. */
function endingTool(name: string, fn: () => unknown): AgencyFunction {
  return new AgencyFunction({
    name,
    module: "test.agency",
    fn,
    params: [],
    toolDefinition: { name, description: `The ${name} tool.`, schema: z.object({}) },
  });
}

describe("llmCall expiry", () => {
  const HINT = "just for this call";
  const contents = (messages: smoltalk.Message[]) => messages.map((m) => m.content);

  /** A thread holding one unkeyed llmCall message, and one llm() call on
   *  it that offers `tools`. */
  function runWithHint(mocks: LLMMock[], tools: AgencyFunction[]) {
    const s = setup(mocks);
    // A pause takes a checkpoint, which names the node it was taken in.
    s.ctx.stateStack.nodesTraversed = ["main"];
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage(HINT), null, { at: "llmCall", key: null });
    const result = runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
      runPrompt(run, {
        prompt: "go",
        messages: thread,
        clientConfig: { tools } as any,
        maxToolCallRounds: 10,
      }),
    );
    return { s, thread, result };
  }

  it("an unkeyed llmCall message is claimed by the next call and gone when it returns", async () => {
    const { s, thread, result } = runWithHint([{ return: "done" }], []);
    expect(await result).toBe("done");
    expect(contents(s.client.requests[0])).toContain(HINT);
    expect(contents(thread.getMessages())).not.toContain(HINT);
  });

  it("is gone after a call that ends through endTurn", async () => {
    const finish = endingTool("finish", () => {
      _endTurn("llm");
      return "finished";
    });
    const { s, thread, result } = runWithHint(
      [{ toolCall: { name: "finish", args: {} } }],
      [finish],
    );
    await result;
    expect(s.client.requests).toHaveLength(1);
    expect(contents(thread.getMessages())).not.toContain(HINT);
  });

  it("is gone after a call that throws", async () => {
    const boom = endingTool("boom", () => {
      throw new AgencyCancelledError("cancelled fixture");
    });
    const { thread, result } = runWithHint([{ toolCall: { name: "boom", args: {} } }], [boom]);
    await expect(result).rejects.toBeInstanceOf(AgencyCancelledError);
    expect(contents(thread.getMessages())).not.toContain(HINT);
  });

  it("stays on the thread while the call is paused on an interrupt", async () => {
    const pauseMe = endingTool("pauseMe", () => [
      interrupt({ effect: "test::pause", message: "pause", data: {}, origin: "test", runId: "r1" }),
    ]);
    const { thread, result } = runWithHint(
      [{ toolCall: { name: "pauseMe", args: {} } }],
      [pauseMe],
    );
    const paused = await result;
    expect(Array.isArray(paused)).toBe(true);
    expect(contents(thread.getMessages())).toContain(HINT);
  });
});

describe("the round warning", () => {
  const FINAL = DEFAULT_ROUND_WARNING.finalWarningText;

  /** For each request, the round warnings it carried. */
  const warningsPerRequest = (s: Setup) =>
    s.client.requests.map((messages) =>
      messages.filter((m) => labelOf(m) === "roundWarning").map((m) => m.content),
    );

  /** One call with a cap of `cap` that pings until the cap, then answers. */
  async function run(cap: number, warnAtRoundsLeft?: WarnAtRoundsLeft) {
    const s = setup(pingMocks(cap));
    const thread = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (r) =>
      call(r, s, thread, { baked: cap, warnAtRoundsLeft }),
    );
    return { s, thread };
  }

  it("warns at 3 left and on the last round, once each, and the thread holds neither afterwards", async () => {
    const { s, thread } = await run(5);
    const warnings = warningsPerRequest(s);
    expect(warnings[2]).toEqual([
      "Of the 5 tool rounds for this request, 3 remain. Finish what you can with them and then write your answer.",
    ]);
    // The first warning stays in the thread for the rest of the call, so
    // later requests carry it too; only one new warning is added each time.
    expect(warnings.map((w) => w.length)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(warnings[4][1]).toBe(FINAL);
    expect(thread.getMessages().filter((m) => labelOf(m) === "roundWarning")).toEqual([]);
  });

  it("remaining: 0 sends only the final warning", async () => {
    const { s } = await run(5, { remaining: 0 });
    expect(warningsPerRequest(s).at(-1)).toEqual([FINAL]);
  });

  it("finalWarning: false sends only the first", async () => {
    const { s } = await run(5, { finalWarning: false });
    const last = warningsPerRequest(s).at(-1)!;
    expect(last).toHaveLength(1);
    expect(last[0]).toContain("3 remain");
  });

  it("a cap of 2 sends only the final warning, after round 0", async () => {
    const { s } = await run(2);
    expect(warningsPerRequest(s)).toEqual([[], [FINAL], [FINAL]]);
  });

  it("a custom text without placeholders is sent as given", async () => {
    const { s } = await run(5, { text: "Wrap up soon." });
    expect(warningsPerRequest(s)[2]).toEqual(["Wrap up soon."]);
  });

  it("the call's warnAtRoundsLeft merges field by field over the branch default", async () => {
    const s = setup(pingMocks(5));
    const thread = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, async (r) => {
      _setLlmOptions({ warnAtRoundsLeft: { remaining: 2 } });
      await call(r, s, thread, { baked: 5, warnAtRoundsLeft: { text: "custom {remaining}" } });
    });
    const warnings = warningsPerRequest(s);
    // The branch's threshold of 2 holds: nothing after round 1.
    expect(warnings[2]).toEqual([]);
    expect(warnings[3]).toEqual(["custom 2"]);
    expect(warnings[4]).toEqual(["custom 2", FINAL]);
  });
});

describe("the request that leads to each round", () => {
  it("a cap of 1 still offers tools on the first request", async () => {
    const s = setup(pingMocks(1));
    const thread = new MessageThread();
    await runInTestContext(s.ctx, s.ctx.stateStack, s.threads, (run) =>
      call(run, s, thread, { baked: 1 }),
    );
    expect(s.runs()).toBe(1);
    expect(s.client.offered).toEqual([["ping"], []]);
    expect(refusals(thread)).toHaveLength(0);
  });
});
