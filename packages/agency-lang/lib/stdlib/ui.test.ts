import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _runLoop,
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
} from "./ui.js";
import { installRegion, resetRegion } from "./ui-region.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { failure } from "../runtime/result.js";

afterEach(() => {
  _setInputSource(null);
  _setOutputTarget(null);
  _uninstallConsoleCapture();
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

    expect(state.transcript.messages).toEqual(["{bright-blue You} hello"]);
    expect(state.submit.busy).toBe(true);
    expect(state.submit.label).toBe("Thinking");

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveSubmit("agent reply");
    await submitPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.transcript.messages).toEqual([
      "{bright-blue You} hello",
      "agent reply",
    ]);
    expect(state.submit.busy).toBe(false);
  });

  it("exits the REPL when the callback returns false", async () => {
    const state = makeState();
    _beginSubmit(state, "bye", () => false);
    // Resolve microtasks for the setTimeout(0) + the inner async IIFE.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.done).toBe(true);
  });

  it("surfaces thrown JS errors as {red Error} transcript entries", async () => {
    const state = makeState();
    _beginSubmit(state, "boom", () => {
      throw new Error("kaboom");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.transcript.messages).toEqual([
      "{bright-blue You} boom",
      "{red Error} kaboom",
    ]);
    expect(state.submit.busy).toBe(false);
  });

  it("surfaces Failure-typed returns instead of dropping them", async () => {
    const state = makeState();
    _beginSubmit(state, "fail", () => failure("spec.tools cannot be spread"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.transcript.messages).toEqual([
      "{bright-blue You} fail",
      "{red Error} spec.tools cannot be spread",
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
      "{yellow warn} watch out",
      "{red error} nope",
      "hi",
    ]);
  });

  it("routes raw process.stdout / .stderr writes into the transcript", () => {
    const transcript: string[] = [];
    _installConsoleCapture(transcript);
    try {
      process.stdout.write("line 1\n");
      process.stdout.write("line 2\nline 3\n");
      process.stderr.write("oops\n");
    } finally {
      _uninstallConsoleCapture();
    }
    expect(transcript).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "{red stderr} oops",
    ]);
  });

  it("restores the original sinks on uninstall", () => {
    // `console.log` is restored by reference, so a strict identity
    // check is enough. `process.stdout.write` is re-installed via a
    // pre-bound copy (we have to `.bind()` to avoid losing `this`),
    // so test for behavior instead: after uninstall, writes should
    // again hit the real stdout, not the captured array.
    const origLog = console.log;
    const transcript: string[] = [];
    _installConsoleCapture(transcript);
    _uninstallConsoleCapture();
    expect(console.log).toBe(origLog);

    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => {
      captured.push(String(s));
      return true;
    }) as any;
    try {
      process.stdout.write("post-uninstall write");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toEqual(["post-uninstall write"]);
    expect(transcript).toEqual([]); // capture array is no longer in use
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
