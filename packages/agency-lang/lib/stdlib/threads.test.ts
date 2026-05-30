import { describe, it, expect, vi } from "vitest";

/**
 * Pin the eager-summarize wiring contract for `thread(summarize:
 * true) { ... }`. The hook in `lib/stdlib/threads.ts` is the only
 * thing that translates the `eagerSummarize: true` payload field
 * into a real LLM call + `MessageThread.summary` write. A regression
 * that breaks this would silently revert to lazy-only behavior; the
 * Agency-side `summaryFor` path still works, but the "snappy
 * /sessions" UX the registry feature promises disappears.
 *
 * Mocks `runPrompt` instead of going through the deterministic LLM
 * client because (a) we only care about the wiring, not the prompt
 * format, and (b) the deterministic client requires a fuller
 * RuntimeContext setup than these focused tests need.
 */
vi.mock("../runtime/prompt.js", () => ({
  runPrompt: vi.fn(async () => ({ summary: "spy-summary" })),
}));

import { agency } from "../runtime/agency.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { MessageThread } from "../runtime/state/messageThread.js";
import { runPrompt } from "../runtime/prompt.js";
import { _eagerSummarizeIfNeeded } from "./threads.js";

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

describe("_eagerSummarizeIfNeeded", () => {
  it("calls the LLM and writes MessageThread.summary when eagerSummarize is true", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    threads.get(id).addMessage({ role: "user", content: "hello" } as any);
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        _eagerSummarizeIfNeeded({
          threadId: `t${id}`,
          eagerSummarize: true,
          messages: [{ role: "user", content: "hello" } as any],
        }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(threads.get(id).summary).toBe("spy-summary");
  });

  it("uses a standalone MessageThread for the LLM call (does NOT append to the active thread)", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        _eagerSummarizeIfNeeded({
          threadId: `t${id}`,
          eagerSummarize: true,
          messages: [{ role: "user", content: "x" } as any],
        }),
    );

    // The thread passed to runPrompt must be a fresh standalone
    // MessageThread, not the closing thread or the default active
    // thread. Both would cause the summarizer prompt to pollute the
    // user's conversation history.
    const passedThread = spy.mock.calls[0][0].messages as MessageThread;
    expect(passedThread).toBeInstanceOf(MessageThread);
    expect(passedThread).not.toBe(threads.get(id));
    expect(passedThread).not.toBe(threads.active());
    expect(passedThread.messages.length).toBe(0);
  });

  it("no-ops when eagerSummarize is false", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        _eagerSummarizeIfNeeded({
          threadId: `t${id}`,
          eagerSummarize: false,
          messages: [{ role: "user", content: "x" } as any],
        }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(threads.get(id).summary).toBe(null);
  });

  it("no-ops when messages is empty", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        _eagerSummarizeIfNeeded({
          threadId: `t${id}`,
          eagerSummarize: true,
          messages: [],
        }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(threads.get(id).summary).toBe(null);
  });

  it("no-ops when the thread already has a summary (idempotency / cost guard)", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    threads.get(id).summary = "already-set";
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        _eagerSummarizeIfNeeded({
          threadId: `t${id}`,
          eagerSummarize: true,
          messages: [{ role: "user", content: "x" } as any],
        }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(threads.get(id).summary).toBe("already-set");
  });

  it("swallows LLM errors silently (best-effort)", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error("boom"));

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        // Should NOT throw — the eager hook must never propagate
        // its errors up to the caller's `Runner.thread` finally
        // block (it would mask the user's real exception).
        expect(
          _eagerSummarizeIfNeeded({
            threadId: `t${id}`,
            eagerSummarize: true,
            messages: [{ role: "user", content: "x" } as any],
          }),
        ).resolves.toBeUndefined(),
    );

    expect(threads.get(id).summary).toBe(null);
  });

  it("tolerates non-canonical (non-slug) thread ids by passing them through", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    // Explicitly use a non-slug id to verify the same /^t\d+$/
    // tightening other helpers do.
    threads.threads["custom-id"] = new MessageThread();
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () =>
        _eagerSummarizeIfNeeded({
          threadId: "custom-id",
          eagerSummarize: true,
          messages: [{ role: "user", content: "x" } as any],
        }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(threads.threads["custom-id"].summary).toBe("spy-summary");
  });
});
