import { describe, expect, it } from "vitest";
import { AgencyCancelledError } from "../runtime/errors.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import {
  PROGRAM_OUTPUT_LIMIT,
  ProgramFailed,
  abortableSleep,
  abortableSpawn,
  runProgram,
} from "./abortable.js";
import { nodeHost } from "../host/node/nodeHost.js";
import { memoryHost } from "../host/memoryHost.js";
import type { RunOptions, RunResult } from "../host/host.js";

/** A child that exited with 0 and printed `stdout`. */
function finished(stdout: string): RunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    truncated: null,
    timedOut: false,
    aborted: false,
  };
}

const host = nodeHost();
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
    await expect(abortableSleep(60_000, ac.signal)).rejects.toBeInstanceOf(AgencyCancelledError);
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
    const p = abortableSpawn(host, "sleep", ["60"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("returns normally when the child exits before any abort", async () => {
    const result = await abortableSpawn(host, "printf", ["hello"], {
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
    const result = await abortableSpawn(host, "true", [], {
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
    const result = await abortableSpawn(host, "yes", [], {
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[output truncated at 1000 bytes]");
  });

  it("reports a failure, not a success, when standard error is what overflowed", async () => {
    const result = await abortableSpawn(host, "sh", ["-c", "exec yes >&2"], {
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[standard error truncated at 1000 bytes]");
  });
});

describe("runProgram", () => {
  it("returns the output of a child that exits with 0", async () => {
    const { stdout } = await runProgram(host, "printf", ["hi"]);
    expect(stdout).toBe("hi");
  });

  it("rejects with ProgramFailed, carrying the output, on a non-zero exit", async () => {
    const failure = await runProgram(host, "sh", ["-c", "echo out; echo err >&2; exit 3"]).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ProgramFailed);
    expect(failure.exitCode).toBe(3);
    expect(failure.stdout).toBe("out\n");
    expect(failure.stderr).toBe("err\n");
    expect(failure.message).toContain("exited with code 3");
  });

  it("limits each output stream to execFile's default unless told otherwise", async () => {
    const seen: RunOptions[] = [];
    const recording = memoryHost({
      subprocess: {
        run: async (_command, options) => {
          seen.push(options ?? {});
          return finished("");
        },
        start: async () => {
          throw new Error("not started here");
        },
        locate: async () => null,
      },
    });
    await runProgram(recording, "x", []);
    await runProgram(recording, "x", [], { maxOutputBytes: 5 });
    expect(seen[0].maxOutputBytes).toBe(PROGRAM_OUTPUT_LIMIT);
    expect(seen[1].maxOutputBytes).toBe(5);
  });

  it("rejects a child that wrote past the limit, even one that exited with 0", async () => {
    // The child finishes before the kill reaches it, so its exit code is 0.
    const failure = await runProgram(host, "printf", ["abcdefgh"], { maxOutputBytes: 4 }).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ProgramFailed);
    expect(failure.message).toContain("wrote more than 4 bytes to stdout");
    expect(failure.stdout).toBe("abcd");
  });

  it("rejects a child killed at its deadline or cancelled, even one that exited with 0", async () => {
    // A child can handle the signal and still exit with 0; the host says
    // what happened, and `runProgram` does not take the output as an answer.
    const answers: RunResult[] = [
      { ...finished("late"), timedOut: true },
      { ...finished("gone"), aborted: true },
    ];
    const scripted = memoryHost({
      subprocess: {
        run: async () => answers.shift()!,
        start: async () => {
          throw new Error("not started here");
        },
        locate: async () => null,
      },
    });
    const late = await runProgram(scripted, "x", [], { timeoutMs: 5 }).catch((error) => error);
    expect(late).toBeInstanceOf(ProgramFailed);
    expect(late.message).toContain("did not finish within 5 ms");
    expect(late.stdout).toBe("late");
    const gone = await runProgram(scripted, "x", []).catch((error) => error);
    expect(gone).toBeInstanceOf(ProgramFailed);
    expect(gone.message).toContain("was cancelled");
  });

  it("limits standard error as well as standard output", async () => {
    // `exec` so the writer is the child itself and the kill reaches it.
    const failure = await runProgram(host, "sh", ["-c", "exec yes >&2"], {
      maxOutputBytes: 1000,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProgramFailed);
    expect(failure.message).toContain("wrote more than 1000 bytes to stderr");
    expect(Buffer.byteLength(failure.stderr, "utf8")).toBe(1000);
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
    const result = await __internal_exec(ctx, stack, threads, "printf", ["ok"], "", 0, "");
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });
});
