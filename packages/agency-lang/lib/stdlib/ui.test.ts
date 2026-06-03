import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _runLoop,
  _runReplLoop,
  _setInputSource,
  _setOutputTarget,
  _setSize,
  _hasActiveScreen,
  _recordedFrameTexts,
  _beginSubmit,
  _elapsedSeconds,
  _spinnerFrame,
  _installConsoleCapture,
  _uninstallConsoleCapture,
  BottomRegionOutputTarget,
  _writeScrollLine,
  _openChoicePrompt,
  _resolveChoice,
  _cancelChoice,
  _hasPendingChoice,
  _peekReplExitSignal,
  _resetReplExitSignal,
  _signalReplExit,
} from "./ui.js";
import { installRegion, resetRegion } from "./ui-region.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { failure } from "../runtime/result.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { runInTestContext } from "../runtime/asyncContext.js";

afterEach(() => {
  _setInputSource(null);
  _setOutputTarget(null);
  _uninstallConsoleCapture();
  _resetReplExitSignal();
});

describe("std::ui bridge — _runLoop", () => {
  it("drives the loop with scripted keys and returns final state", async () => {
    const input = new ScriptedInput([
      { key: "down" },
      { key: "down" },
      { key: "q" },
    ]);
    const output = new FrameRecorder();
    _setInputSource(input);
    _setOutputTarget(output);
    _setSize(40, 5);

    const finalState = await _runLoop(
      { count: 0, done: false },
      (s: any) => ({ type: "text", content: "n=" + s.count }),
      (s: any, ev: any) => {
        if (ev.key === "q") return { ...s, done: true };
        if (ev.key === "down") return { ...s, count: s.count + 1 };
        return s;
      },
      (s: any) => s.done,
    );
    expect(finalState.count).toBe(2);
    expect(finalState.done).toBe(true);
    expect(_hasActiveScreen()).toBe(false);
  });

  it("registers the active screen while the loop runs", async () => {
    const input = new ScriptedInput([{ key: "q" }]);
    const output = new FrameRecorder();
    _setInputSource(input);
    _setOutputTarget(output);
    _setSize(40, 5);

    let sawActive = false;
    await _runLoop(
      { done: false },
      (_s: any) => ({ type: "text", content: "x" }),
      (_s: any, ev: any) => {
        sawActive = _hasActiveScreen();
        return { done: ev.key === "q" };
      },
      (s: any) => s.done,
    );
    expect(sawActive).toBe(true);
    expect(_hasActiveScreen()).toBe(false);
  });

  it("exits via tickMs without needing a key", async () => {
    // No scripted keys — `isDone` flips once `renderCount` crosses the
    // threshold. Verifies the tick branch of Screen.runLoop is actually
    // exercised end-to-end via _runLoop's TS coercion.
    const input = new ScriptedInput([]);
    const output = new FrameRecorder();
    _setInputSource(input);
    _setOutputTarget(output);
    _setSize(40, 5);

    let renderCount = 0;
    const finalState = await _runLoop(
      { done: false },
      (_s: any) => {
        renderCount += 1;
        return { type: "text", content: `r${renderCount}` };
      },
      (s: any) => s,
      (_s: any) => renderCount >= 4,
      20,
    );
    expect(finalState).toEqual({ done: false });
    expect(renderCount).toBeGreaterThanOrEqual(4);
  });

  it("treats null / 0 / negative tickMs as no-tick", async () => {
    // The Agency wrapper passes `null` to mean off; the bridge must
    // coerce so Screen.runLoop does not enter its tick branch and
    // start a 0ms `setTimeout` tight loop.
    const input = new ScriptedInput([{ key: "q" }]);
    const output = new FrameRecorder();
    _setInputSource(input);
    _setOutputTarget(output);
    _setSize(40, 5);

    await _runLoop(
      { done: false },
      (_s: any) => ({ type: "text", content: "x" }),
      (s: any, ev: any) => ({ ...s, done: ev.key === "q" }),
      (s: any) => s.done,
      null,
    );
    // If the coercion regressed this test would hang in a tight loop
    // and time out instead of completing.
    expect(_hasActiveScreen()).toBe(false);
  });
});

describe("std::ui bridge — recorded frames", () => {
  it("returns text from an injected FrameRecorder", async () => {
    const input = new ScriptedInput([{ key: "q" }]);
    const output = new FrameRecorder();
    _setInputSource(input);
    _setOutputTarget(output);
    _setSize(24, 4);

    await _runLoop(
      { done: false },
      (_ignoredState: any) => ({ type: "text", content: "hello frame" }),
      (_ignoredState: any, keyEvent: any) => ({ done: keyEvent.key === "q" }),
      (state: any) => state.done,
    );

    expect(_recordedFrameTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining("hello frame")]),
    );
  });
});

describe("std::ui bridge — _beginSubmit", () => {
  function makeState() {
    return {
      done: false as boolean | undefined,
      submit: { busy: false, label: "", startedAtMs: 0 },
      transcript: { messages: [] as string[] },
    };
  }

  it("sets busy before the callback resolves and appends the reply after", async () => {
    const state = makeState();
    let resolveSubmit: (value: string) => void = () => {};
    const submitPromise = new Promise<string>((resolve) => {
      resolveSubmit = resolve;
    });

    _beginSubmit(state, "hello", () => submitPromise);

    expect(state.transcript.messages).toEqual(["{bright-blue-fg}You{/bright-blue-fg} hello"]);
    expect(state.submit.busy).toBe(true);
    expect(state.submit.label).toBe("Thinking");

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveSubmit("agent reply");
    await submitPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.transcript.messages).toEqual([
      "{bright-blue-fg}You{/bright-blue-fg} hello",
      "agent reply",
    ]);
    expect(state.submit.busy).toBe(false);
  });

  it("exits the REPL by setting the bridge exit signal when the callback returns false", async () => {
    const state = makeState();
    _resetReplExitSignal();
    expect(_peekReplExitSignal()).toBe(false);
    _beginSubmit(state, "bye", () => false);
    // Resolve microtasks for the setTimeout(0) + the inner async IIFE.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The bridge flag is set instead of state.done — see
    // `_signalReplExit` in lib/stdlib/ui.ts for why mutating
    // `state.done` directly is unsafe across reducer-state turnover.
    expect(_peekReplExitSignal()).toBe(true);
  });

  it("surfaces thrown JS errors as {red-fg}Error{/red-fg} transcript entries", async () => {
    const state = makeState();
    _beginSubmit(state, "boom", () => {
      throw new Error("kaboom");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.transcript.messages).toEqual([
      "{bright-blue-fg}You{/bright-blue-fg} boom",
      "{red-fg}Error{/red-fg} kaboom",
    ]);
    expect(state.submit.busy).toBe(false);
  });

  it("surfaces Failure-typed returns instead of dropping them", async () => {
    const state = makeState();
    _beginSubmit(state, "fail", () => failure("spec.tools cannot be spread"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.transcript.messages).toEqual([
      "{bright-blue-fg}You{/bright-blue-fg} fail",
      "{red-fg}Error{/red-fg} spec.tools cannot be spread",
    ]);
    expect(state.submit.busy).toBe(false);
  });

  it("computes elapsed seconds and spinner frames deterministically", () => {
    expect(_elapsedSeconds(1_000, 3_400)).toBe(2);
    expect(_spinnerFrame(1_000, 1_000)).toBe("|");
    expect(_spinnerFrame(1_000, 1_250)).toBe("/");
    expect(_spinnerFrame(1_000, 1_500)).toBe("-");
    expect(_spinnerFrame(1_000, 1_750)).toBe("\\");
    expect(_spinnerFrame(1_000, 2_000)).toBe("|");
  });
});

describe("std::ui bridge — console capture", () => {
  it("routes console.log / .warn / .error into the transcript", () => {
    const transcript: string[] = [];
    _installConsoleCapture(transcript);
    try {
      console.log("first");
      console.warn("watch out");
      console.error("nope");
      console.info("hi");
    } finally {
      _uninstallConsoleCapture();
    }
    expect(transcript).toEqual([
      "first",
      "{yellow-fg}warn{/yellow-fg} watch out",
      "{red-fg}error{/red-fg} nope",
      "hi",
    ]);
  });

  it("does NOT intercept raw process.stdout / .stderr writes", () => {
    // Console capture only patches the high-level `console.*` methods.
    // Raw stdout/stderr writes pass straight through to the terminal —
    // we deliberately don't capture them because the TUI renderer
    // (`lib/tui/output/terminal.ts`) writes its ANSI frames through
    // `process.stdout.write`, and intercepting those would swallow
    // rendering output / spam ANSI into the transcript.
    const transcript: string[] = [];
    const realWrites: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => {
      realWrites.push(String(s));
      return true;
    }) as any;
    _installConsoleCapture(transcript);
    try {
      process.stdout.write("not captured\n");
    } finally {
      _uninstallConsoleCapture();
      process.stdout.write = origWrite;
    }
    expect(transcript).toEqual([]);
    expect(realWrites).toEqual(["not captured\n"]);
  });

  it("truncates a captured multi-line error to the first couple of lines", async () => {
    // A `__log.error(stack)` from the runtime's catch-and-convert path
    // can be a multi-page stack trace. With the truncation in place
    // the transcript shows the error head plus a gray placeholder
    // for the rest — keeps the TUI legible without dropping evidence
    // that something went wrong.
    const { truncateForTui } = await import("./ui.js");
    const stack = [
      "Error: kaboom",
      "    at fn (file.ts:1:1)",
      "    at caller (file.ts:2:2)",
      "    at next (file.ts:3:3)",
      "    at outer (file.ts:4:4)",
      "    at top (file.ts:5:5)",
      "    at tip (file.ts:6:6)",
    ].join("\n");
    const out = truncateForTui(stack);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Error: kaboom");
    expect(lines[1]).toBe("    at fn (file.ts:1:1)");
    expect(lines[lines.length - 1]).toContain("2 more lines omitted");
  });

  it("leaves short messages untouched", async () => {
    const { truncateForTui } = await import("./ui.js");
    expect(truncateForTui("just one line")).toBe("just one line");
    expect(truncateForTui("line one\nline two")).toBe("line one\nline two");
  });

  it("captured console.error of a multi-line payload renders truncated", () => {
    // End-to-end of the truncation through the console capture so a
    // regression in the prefix-join path doesn't slip past.
    const transcript: string[] = [];
    _installConsoleCapture(transcript);
    try {
      console.error("head\nframe1\nframe2\nframe3\nframe4\nframe5\nframe6");
    } finally {
      _uninstallConsoleCapture();
    }
    // Captured as one entry per line of the truncated payload, each
    // prefixed by the `error` tag.
    expect(transcript[0]).toBe("{red-fg}error{/red-fg} head");
    expect(transcript[1]).toContain("frame1");
    expect(transcript[transcript.length - 1]).toContain("omitted");
  });

  it("restores the original console sinks on uninstall", () => {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const transcript: string[] = [];
    _installConsoleCapture(transcript);
    expect(console.log).not.toBe(origLog); // patched
    _uninstallConsoleCapture();
    expect(console.log).toBe(origLog);
    expect(console.warn).toBe(origWarn);
    expect(console.error).toBe(origError);
  });
});

describe("std::ui bridge — _runReplLoop cleanup", () => {
  it("uninstalls console capture even when the inner loop throws", async () => {
    _setInputSource(new ScriptedInput([{ key: "q" }]));
    _setOutputTarget(new FrameRecorder());
    _setSize(40, 5);
    const origLog = console.log;
    const transcript: string[] = [];
    await expect(
      _runReplLoop(
        { done: false },
        (_s: any) => ({ type: "text", content: "x" }),
        () => {
          throw new Error("boom");
        },
        (s: any) => s.done,
        null,
        transcript,
      ),
    ).rejects.toThrow("boom");
    // Critical safety property: console must be restored even on the
    // error path. A leak here would leave process-wide console.log
    // pointing at a detached transcript array for the rest of the run.
    expect(console.log).toBe(origLog);
  });

  it("uninstalls console capture on normal completion", async () => {
    _setInputSource(new ScriptedInput([{ key: "q" }]));
    _setOutputTarget(new FrameRecorder());
    _setSize(40, 5);
    const origLog = console.log;
    const transcript: string[] = [];
    await _runReplLoop(
      { done: false },
      (_s: any) => ({ type: "text", content: "x" }),
      (_s: any, ev: any) => ({ done: ev.key === "q" }),
      (s: any) => s.done,
      null,
      transcript,
    );
    expect(console.log).toBe(origLog);
  });
});

describe("std::ui bridge — BottomRegionOutputTarget", () => {
  let stdoutWrites: string[] = [];
  let origWrite: typeof process.stdout.write;
  let origIsTTY: boolean | undefined;
  let origRows: number | undefined;

  beforeEach(() => {
    stdoutWrites = [];
    origWrite = process.stdout.write.bind(process.stdout);
    origIsTTY = process.stdout.isTTY;
    origRows = process.stdout.rows;
    (process.stdout as any).isTTY = true;
    (process.stdout as any).rows = 24;
    process.stdout.write = ((s: any) => {
      stdoutWrites.push(String(s));
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    (process.stdout as any).isTTY = origIsTTY;
    (process.stdout as any).rows = origRows;
    resetRegion();
  });

  it("wraps the frame write in save+move+restore and emits ANSI", () => {
    installRegion(3); // scrollBottom = 21 → bottom region starts at row 22
    stdoutWrites.length = 0;
    const target = new BottomRegionOutputTarget();
    // toANSI expects a Frame; pass an empty cells grid to keep it minimal.
    target.write({ width: 0, height: 0, cells: [] } as any);
    const out = stdoutWrites.join("");
    expect(out).toContain("\x1b[s"); // save cursor
    expect(out).toContain("\x1b[22;1H"); // move to bottom region
    expect(out).toContain("\x1b[u"); // restore cursor
  });

  it("destroy() is a no-op (owns no resources)", () => {
    const target = new BottomRegionOutputTarget();
    expect(() => target.destroy()).not.toThrow();
  });
});

describe("std::ui bridge — _writeScrollLine", () => {
  let stdoutWrites: string[] = [];
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutWrites = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => {
      stdoutWrites.push(String(s));
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
  });

  it("writes the text followed by a newline (no ANSI)", () => {
    _writeScrollLine("hello world");
    expect(stdoutWrites.join("")).toBe("hello world\n");
  });
});

describe("std::ui bridge — choice prompts", () => {
  afterEach(() => {
    // Drain any pending prompt so a failed test doesn't leak state
    // into the next one (the slot is module-level).
    if (_hasPendingChoice()) _cancelChoice("test cleanup");
  });

  it("stores the request and resolves with the chosen key", async () => {
    const promise = _openChoicePrompt({
      title: "Pick one",
      body: "context",
      items: [
        { key: "a", label: "Approve" },
        { key: "r", label: "Reject" },
      ],
    });
    expect(_hasPendingChoice()).toBe(true);
    _resolveChoice("a");
    await expect(promise).resolves.toBe("a");
    expect(_hasPendingChoice()).toBe(false);
  });

  it("rejects with the supplied reason on cancel", async () => {
    const promise = _openChoicePrompt({
      title: "T",
      body: "",
      items: [{ key: "y", label: "yes" }],
    });
    _cancelChoice("user cancelled");
    await expect(promise).rejects.toThrow("user cancelled");
    expect(_hasPendingChoice()).toBe(false);
  });

  it("rejects when another prompt is already open", async () => {
    const first = _openChoicePrompt({
      title: "first",
      body: "",
      items: [{ key: "a", label: "A" }],
    });
    await expect(
      _openChoicePrompt({
        title: "second",
        body: "",
        items: [{ key: "b", label: "B" }],
      }),
    ).rejects.toThrow(/already open/);
    _cancelChoice("cleanup");
    await expect(first).rejects.toThrow();
  });

  it("_resolveChoice and _cancelChoice are no-ops with no pending prompt", () => {
    expect(() => _resolveChoice("anything")).not.toThrow();
    expect(() => _cancelChoice("anything")).not.toThrow();
    expect(_hasPendingChoice()).toBe(false);
  });

  it("isolates choice prompts and exit signals across concurrent RuntimeContexts", async () => {
    // Drive two concurrent ALS frames (simulating two Agency runs in
    // the same process — e.g. an agent orchestrating a subagent that
    // also calls repl()). Each one opens a choice prompt and signals
    // exit; we then verify the state slots don't bleed across frames.
    function makeCtx(): RuntimeContext<any> {
      return new RuntimeContext({
        statelogConfig: {
          host: "https://example.com",
          apiKey: "k",
          projectId: "p",
          debugMode: false,
        },
        smoltalkDefaults: {},
        dirname: "/tmp",
      });
    }
    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const stackA = new StateStack();
    const stackB = new StateStack();
    const threadsA = new ThreadStore();
    const threadsB = new ThreadStore();

    // In ctxA, open a prompt and signal exit.
    let promiseA: Promise<string> | null = null;
    await runInTestContext(ctxA, stackA, threadsA, async () => {
      promiseA = _openChoicePrompt({
        title: "A",
        body: "",
        items: [{ key: "a", label: "A" }],
      });
      expect(_hasPendingChoice()).toBe(true);
      _signalReplExit();
      expect(_peekReplExitSignal()).toBe(true);
    });

    // ctxB should see NEITHER the prompt nor the exit signal.
    await runInTestContext(ctxB, stackB, threadsB, async () => {
      expect(_hasPendingChoice()).toBe(false);
      expect(_peekReplExitSignal()).toBe(false);

      // ctxB opens its own prompt and signal — should not affect A.
      const promiseB = _openChoicePrompt({
        title: "B",
        body: "",
        items: [{ key: "b", label: "B" }],
      });
      _signalReplExit();
      _resolveChoice("b");
      await expect(promiseB).resolves.toBe("b");
      _resetReplExitSignal();
    });

    // ctxA's prompt and exit signal are still pending — resolve them.
    await runInTestContext(ctxA, stackA, threadsA, async () => {
      expect(_hasPendingChoice()).toBe(true);
      expect(_peekReplExitSignal()).toBe(true);
      _resolveChoice("a");
      _resetReplExitSignal();
    });
    await expect(promiseA).resolves.toBe("a");
  });

  it("_runReplLoop cancels a dangling choice prompt on exit", async () => {
    _setInputSource(new ScriptedInput([{ key: "q" }]));
    _setOutputTarget(new FrameRecorder());
    _setSize(40, 5);
    const transcript: string[] = [];
    // Open a prompt as soon as the first render runs — by the time
    // the loop exits (key "q"), the prompt is still dangling and
    // should be rejected by the finally block in _runReplLoop.
    let dangling: Promise<string> | null = null;
    await _runReplLoop(
      { done: false },
      (_s: any) => {
        if (!dangling) {
          dangling = _openChoicePrompt({
            title: "t",
            body: "",
            items: [{ key: "a", label: "A" }],
          });
        }
        return { type: "text", content: "x" };
      },
      (_s: any, ev: any) => ({ done: ev.key === "q" }),
      (s: any) => s.done,
      null,
      transcript,
    );
    expect(dangling).not.toBeNull();
    await expect(dangling).rejects.toThrow(/REPL loop exited/);
    expect(_hasPendingChoice()).toBe(false);
  });
});
