import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { __internal_input } from "./builtins.js";

// inputImpl reads process.stdin/stdout at call time, so tests swap in a
// PassThrough pair for the duration of each test. `isTTY` is set per-test:
// the buffered-blank-line filter must only ever run on interactive stdin.
type FakeStream = PassThrough & { isTTY?: boolean };

let fakeStdin: FakeStream;
let fakeStdout: FakeStream;
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
const realStdout = Object.getOwnPropertyDescriptor(process, "stdout");

function swapStd(name: "stdin" | "stdout", stream: FakeStream) {
  Object.defineProperty(process, name, { value: stream, configurable: true });
}

function restoreStd() {
  if (realStdin) Object.defineProperty(process, "stdin", realStdin);
  if (realStdout) Object.defineProperty(process, "stdout", realStdout);
}

/** Minimal ctx/stack: no guards, no override, a never-aborting signal. */
function makeCtxStack() {
  const controller = new AbortController();
  const ctx = {
    inputOverride: undefined,
    getAbortSignal: () => controller.signal,
  } as any;
  const stack = { guards: [] } as any;
  return { ctx, stack };
}

function callInput(prompt = "> "): Promise<string> {
  const { ctx, stack } = makeCtxStack();
  return __internal_input(ctx, stack, undefined as any, prompt);
}

beforeEach(() => {
  fakeStdin = new PassThrough();
  fakeStdout = new PassThrough();
  fakeStdout.resume(); // discard prompt echoes so the sink never backpressures
  swapStd("stdin", fakeStdin);
  swapStd("stdout", fakeStdout);
});

afterEach(() => {
  restoreStd();
});

describe("input() and buffered lines", () => {
  it("skips a blank line buffered before the prompt and returns the next real line (TTY)", async () => {
    fakeStdin.isTTY = true;
    // Both lines were typed while the program was busy (e.g. during a slow
    // LLM call): a liveness Enter, then the real message.
    fakeStdin.write("\nhello\n");
    await expect(callInput()).resolves.toBe("hello");
  });

  it("skips several buffered blank lines in a row (TTY)", async () => {
    fakeStdin.isTTY = true;
    fakeStdin.write("\n\n\nhello\n");
    await expect(callInput()).resolves.toBe("hello");
  });

  it("accepts a deliberate blank line typed after the prompt is visible (TTY)", async () => {
    fakeStdin.isTTY = true;
    const pending = callInput();
    // A human pressing Enter at a visible prompt: arrives well after the
    // prompt attached, so it is a real (empty) answer, not buffered residue.
    setTimeout(() => fakeStdin.write("\n"), 80);
    await expect(pending).resolves.toBe("");
  });

  it("keeps a blank line from piped, non-TTY stdin (scripts are never filtered)", async () => {
    fakeStdin.write("\n");
    await expect(callInput()).resolves.toBe("");
  });

  it("keeps a buffered non-empty line (type-ahead is preserved) (TTY)", async () => {
    fakeStdin.isTTY = true;
    fakeStdin.write("typed ahead\n");
    await expect(callInput()).resolves.toBe("typed ahead");
  });
});
