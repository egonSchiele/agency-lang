import { describe, it, expect, vi } from "vitest";

/**
 * Pin the contract that `agency.llm` forwards `agency.callsite()` to
 * `runPrompt` as `checkpointInfo`. A regression that drops that
 * forwarding would silently disable interrupt-checkpoint location
 * attribution for TS-issued LLM calls — `getResultCheckpoint()` would
 * still find the result-entry pin, but the runtime checkpoint
 * `PromptRunner` writes when the LLM call interrupts would lose its
 * `moduleId / scopeName / stepPath`. That makes the rewind UI show
 * "unknown location" and breaks `step in / over` after a resumed
 * interrupt. We can't observe `checkpointInfo` via the LLM client
 * (it's consumed by `PromptRunner`, not by the client), so we mock
 * `runPrompt` itself and read the field off the captured args.
 *
 * Lives in its own file because `vi.mock` is module-scoped and we
 * don't want it to replace `runPrompt` for every other agencyLlm
 * test in this directory.
 */
vi.mock("./prompt.js", () => ({
  runPrompt: vi.fn(async () => "spy-response"),
}));

import { agency } from "./agency.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";
import { runPrompt } from "./prompt.js";

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

describe("agency.llm — checkpointInfo forwarding", () => {
  it("passes agency.callsite() to runPrompt as checkpointInfo", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        agency.withCallsite(
          { moduleId: "M", scopeName: "S", stepPath: "1.2" },
          () => agency.llm("hi"),
        ),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      checkpointInfo: { moduleId: "M", scopeName: "S", stepPath: "1.2" },
    });
  });

  it("checkpointInfo is undefined when no callsite is installed", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    // withTestContext installs a frame with `callsite: undefined`.
    // `agency.llm` reads `agencyStore.getStore()?.callsite` so the
    // forwarded value should also be undefined — not a stale value
    // from a previous test, not a synthesized placeholder.
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () => agency.llm("hi"),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].checkpointInfo).toBeUndefined();
  });
});
