import { describe, expect, it, vi } from "vitest";

import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { StatelogClient } from "../statelogClient.js";
import { _evalInput, _evalOutput } from "./statelog.js";

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

function spyClient(ctx: RuntimeContext<any>) {
  const evalInputRecorded = vi.fn(async () => undefined);
  const evalOutputRecorded = vi.fn(async () => undefined);
  ctx.statelogClient = {
    ...ctx.statelogClient,
    evalInputRecorded,
    evalOutputRecorded,
  } as any;
  return { evalInputRecorded, evalOutputRecorded };
}

async function withFrame(
  threads: ThreadStore,
  fn: (spies: ReturnType<typeof spyClient>) => Promise<void>,
): Promise<void> {
  const ctx = makeCtx();
  const spies = spyClient(ctx);
  await runInTestContext(ctx, new StateStack(), threads, () => fn(spies));
}

describe("std::statelog eval annotations", () => {
  it("records eval input with the active thread id", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const threadId = threads.activeId();
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalInput("hello");
    });

    expect(spies.evalInputRecorded).toHaveBeenCalledOnce();
    expect(spies.evalInputRecorded).toHaveBeenCalledWith({
      value: "hello",
      threadId,
    });
  });

  it("round-trips plain objects before recording", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalInput({ foo: 1 });
    });

    expect(spies.evalInputRecorded).toHaveBeenCalledWith({
      value: { foo: 1 },
      threadId: threads.activeId(),
    });
  });

  it("records null and coerces undefined to null", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalOutput(null);
      await _evalOutput(undefined);
    });

    expect(spies.evalOutputRecorded).toHaveBeenNthCalledWith(1, {
      value: null,
      threadId: threads.activeId(),
    });
    expect(spies.evalOutputRecorded).toHaveBeenNthCalledWith(2, {
      value: null,
      threadId: threads.activeId(),
    });
  });

  it("no-ops outside an Agency execution frame", async () => {
    await expect(_evalInput("hello")).resolves.toBeUndefined();
  });

  it("rejects circular values at the call site", async () => {
    const circular: any = {};
    circular.self = circular;
    await withFrame(ThreadStore.withDefaultActive(makeCtx().statelogClient), async () => {
      await expect(_evalInput(circular)).rejects.toThrow(TypeError);
    });
  });

  it("resolves with a disabled statelog client", async () => {
    const ctx = makeCtx();
    ctx.statelogClient = new StatelogClient({
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
      observability: false,
    });
    await runInTestContext(ctx, new StateStack(), new ThreadStore(), async () => {
      await expect(_evalInput("x")).resolves.toBeUndefined();
      await expect(_evalOutput("y")).resolves.toBeUndefined();
    });
  });

  it("records null threadId when there is no active thread", async () => {
    const ctx = makeCtx();
    const threads = new ThreadStore();
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalOutput("x");
    });

    expect(spies.evalOutputRecorded).toHaveBeenCalledWith({
      value: "x",
      threadId: null,
    });
  });
});
