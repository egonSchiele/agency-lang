import { describe, expect, it } from "vitest";
import { AgencyCancelledError } from "../runtime/errors.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { abortableSleep, abortableSpawn } from "./abortable.js";
import { __internal_sleep, __internal_input } from "./builtins.js";
import { __internal_exec, __internal_bash } from "./shell.js";

function makeMockCtx(): RuntimeContext<any> {
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

describe("abortableSleep", () => {
  it("rejects with AgencyCancelledError when the signal fires mid-sleep", async () => {
    const ac = new AbortController();
    const p = abortableSleep(60_000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(60_000, ac.signal)).rejects.toBeInstanceOf(
      AgencyCancelledError,
    );
  });

  it("resolves normally if not aborted", async () => {
    const ac = new AbortController();
    await expect(abortableSleep(10, ac.signal)).resolves.toBeUndefined();
  });
});

describe("abortableSpawn", () => {
  it("kills the child and rejects with AgencyCancelledError on abort", async () => {
    const ac = new AbortController();
    // Use a `sleep` that would block for minutes if not aborted.
    const p = abortableSpawn("sleep", ["60"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("returns normally when the child exits before any abort", async () => {
    const result = await abortableSpawn("printf", ["hello"], {
      signal: new AbortController().signal,
    });
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("resolves (does not crash) when input is written to a child that ignores stdin", async () => {
    // `true` exits immediately without reading stdin, so its stdin pipe has
    // no reader by the time we write. A large payload overflows the pipe
    // buffer and makes the write raise EPIPE. Without an `error` listener on
    // child.stdin that unhandled event crashes the whole process; the handler
    // added in abortable.ts swallows EPIPE so the call resolves instead.
    const bigInput = "x".repeat(1_000_000);
    const result = await abortableSpawn("true", [], {
      input: bigInput,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
  });

  it("resolves with truncated output (does not crash) when the child is killed mid-read", async () => {
    // `yes` streams forever. The byte cap kills the child from inside the
    // stdout `data` handler, tearing down the pipe while a read is in flight
    // — the case where stdout/stderr can emit a late `error`. The stream
    // guards keep that from crashing the process; the call resolves truncated.
    const result = await abortableSpawn("yes", [], {
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[output truncated at 1000 bytes]");
  });
});

describe("__internal_sleep", () => {
  it("wakes up early when ctx.cancel() fires mid-sleep", async () => {
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const p = __internal_sleep(ctx, stack, threads, 60_000);
    setTimeout(() => ctx.cancel("test"), 10);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });
});

describe("__internal_input", () => {
  it("rejects with AgencyCancelledError on abort while waiting on stdin", async () => {
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const p = __internal_input(ctx, stack, threads, "> ");
    setTimeout(() => ctx.cancel("test"), 20);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });
});

describe("__internal_exec / __internal_bash", () => {
  it("__internal_exec: kills child on ctx.cancel and rejects with AgencyCancelledError", async () => {
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const p = __internal_exec(ctx, stack, threads, "sleep", ["60"], "", 0, "");
    // 200ms (not 20ms) so the subprocess has actually started before
    // cancel fires — on slow CI runners 20ms can race against the
    // spawn and leave the signal unobserved.
    setTimeout(() => ctx.cancel("test"), 200);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("__internal_bash: kills sh -c on ctx.cancel and rejects with AgencyCancelledError", async () => {
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    // `exec sleep 60` so the shell replaces itself with the sleep
    // process — without `exec`, dash on Ubuntu CI keeps sh and sleep
    // as separate processes, and our SIGTERM only kills sh while
    // sleep (with inherited pipes) keeps the close event from firing
    // for the full 60s. macOS/bash optimizes this exec away, so the
    // test passed locally but timed out on Linux runners.
    const p = __internal_bash(ctx, stack, threads, "exec sleep 60", "", 0, "");
    // See `__internal_exec` above re: 200ms timer.
    setTimeout(() => ctx.cancel("test"), 200);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("__internal_exec: runs normally when no abort fires", async () => {
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const result = await __internal_exec(
      ctx,
      stack,
      threads,
      "printf",
      ["ok"],
      "",
      0,
      "",
    );
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });
});
