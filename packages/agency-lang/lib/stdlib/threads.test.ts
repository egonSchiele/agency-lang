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
import { _eagerSummarizeIfNeeded, _contentToString } from "./threads.js";

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

  it("respects an explicit empty-string summary as 'already cached'", async () => {
    // Regression: `if (thread.summary)` would treat `""` as falsy
    // and re-summarize, silently overwriting an intentional empty
    // marker (and burning an LLM call). The check is now
    // `thread.summary != null` so any non-null string wins.
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    threads.get(id).summary = "";
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
    expect(threads.get(id).summary).toBe("");
  });

  it("swallows LLM errors and reports them via statelog (best-effort)", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const id = threads.create();
    const spy = runPrompt as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error("boom"));
    // Spy on the statelog reporter to verify the failure is
    // surfaced, not silently dropped.
    const statelogSpy = vi.fn();
    ctx.statelogClient = {
      threadEndHookError: statelogSpy,
    } as any;

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
    expect(statelogSpy).toHaveBeenCalledWith({
      threadId: `t${id}`,
      error: "boom",
    });
  });

  it("excludes system/developer messages from the summarizer transcript", async () => {
    // Regression: the transcript used to include EVERY message, so an
    // agent's multi-thousand-token system prompt was pasted into the
    // "summarize this conversation" prompt. On small local models
    // (llama.cpp) that produced runaway generation that blocked the
    // turn indefinitely; on hosted models it leaked system-prompt
    // content into summaries and wasted tokens.
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
          messages: [
            { role: "system", content: "GIANT SYSTEM PROMPT" } as any,
            { role: "developer", content: "DEV INSTRUCTIONS" } as any,
            { role: "user", content: "say hello" } as any,
            { role: "assistant", content: "Hello!" } as any,
          ],
        }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const prompt = spy.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("GIANT SYSTEM PROMPT");
    expect(prompt).not.toContain("DEV INSTRUCTIONS");
    expect(prompt).toContain("[user] say hello");
    expect(prompt).toContain("[assistant] Hello!");
  });

  it("skips the LLM call entirely when only system messages remain", async () => {
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
          messages: [{ role: "system", content: "only system" } as any],
        }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(threads.get(id).summary).toBe(null);
  });

  it("caps the summarizer's output tokens (runaway-generation guard)", async () => {
    // A 1-2 sentence summary never needs unbounded output. Without a
    // cap, a small local model that fails to emit the closing token
    // generates until its context window fills — the turn (which
    // awaits this hook at thread close) hangs for the duration.
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
          messages: [{ role: "user", content: "hello" } as any],
        }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].clientConfig.maxTokens).toBe(256);
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

describe("_contentToString", () => {
  it("passes plain strings through", () => {
    expect(_contentToString("hello")).toBe("hello");
  });

  it("renders text parts and attachment placeholders", () => {
    const content = [
      { type: "text", text: "look at this" },
      { type: "image", source: { kind: "base64", base64: "AAAA", mimeType: "image/png" } },
      { type: "file", filename: "report.pdf", source: { kind: "base64", base64: "BBBB", mimeType: "application/pdf" } },
    ];
    expect(_contentToString(content as any)).toBe(
      "look at this [image attachment] [file attachment: report.pdf]",
    );
  });

  it("never leaks base64 payloads into the transcript", () => {
    const content = [
      { type: "image", source: { kind: "base64", base64: "SECRETPAYLOAD", mimeType: "image/png" } },
    ];
    expect(_contentToString(content as any)).not.toContain("SECRETPAYLOAD");
  });

  it("handles null content and empty part arrays", () => {
    expect(_contentToString(null as any)).toBe("");
    expect(_contentToString([] as any)).toBe("");
  });

  it("renders a file part without filename generically", () => {
    const content = [{ type: "file", source: { kind: "base64", base64: "CCCC", mimeType: "application/pdf" } }];
    expect(_contentToString(content as any)).toBe("[file attachment]");
  });

  it("renders a text part with a missing text field as empty", () => {
    expect(_contentToString([{ type: "text" }] as any)).toBe("");
  });

  it("falls back to JSON for unknown payload-free part types", () => {
    expect(_contentToString([{ type: "mystery", x: 1 }] as any)).toBe('{"type":"mystery","x":1}');
  });

  it("renders unknown source-carrying parts as placeholders (never dumps payloads)", () => {
    // A future smoltalk part kind (e.g. audio/video) must not regress
    // into base64-in-the-summarizer via the JSON fallback.
    const content = [
      { type: "video", source: { kind: "base64", base64: "FUTUREPAYLOAD", mimeType: "video/mp4" } },
    ];
    expect(_contentToString(content as any)).toBe("[video attachment]");
    expect(_contentToString(content as any)).not.toContain("FUTUREPAYLOAD");
  });

  it("keeps JSON fallback for unknown non-string content", () => {
    expect(_contentToString({ weird: true } as any)).toBe('{"weird":true}');
  });
});
