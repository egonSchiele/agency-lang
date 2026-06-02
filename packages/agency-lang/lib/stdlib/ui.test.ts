import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _runLoop,
  _setInputSource,
  _setOutputTarget,
  _setSize,
  _hasActiveScreen,
  _activateReplState,
  _deactivateReplState,
  _pushMessage,
  _clearMessages,
  _recordedFrameTexts,
  _beginSubmit,
  _elapsedSeconds,
  _spinnerFrame,
  BottomRegionOutputTarget,
  _writeScrollLine,
} from "./ui.js";
import { installRegion, resetRegion } from "./ui-region.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";

afterEach(() => {
  _deactivateReplState();
  _setInputSource(null);
  _setOutputTarget(null);
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
    // The active screen is reset after the loop exits.
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
});

describe("std::ui bridge — active REPL transcript", () => {
  it("pushes styled text into the active transcript", () => {
    const state = { transcript: { messages: [] as string[] } };
    _activateReplState(state);

    _pushMessage("{red first}");
    _pushMessage("{bold second}");

    expect(state.transcript.messages).toEqual(["{red first}", "{bold second}"]);
  });

  it("clears the active transcript", () => {
    const state = { transcript: { messages: ["one", "two"] as string[] } };
    _activateReplState(state);

    _clearMessages();

    expect(state.transcript.messages).toEqual([]);
  });

  it("throws a clear error when no REPL is active", () => {
    _deactivateReplState();

    expect(() => _pushMessage("orphan")).toThrow(
      "pushMessage() requires an active repl()",
    );
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

describe("std::ui bridge — async submit helpers", () => {
  it("sets busy before the callback resolves and appends the reply after", async () => {
    const state = {
      submit: { busy: false, label: "", startedAtMs: 0 },
      transcript: { messages: [] as string[] },
    };

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

  it("computes elapsed seconds and spinner frames deterministically", () => {
    expect(_elapsedSeconds(1_000, 3_400)).toBe(2);
    expect(_spinnerFrame(1_000, 1_000)).toBe("|");
    expect(_spinnerFrame(1_000, 1_250)).toBe("/");
    expect(_spinnerFrame(1_000, 1_500)).toBe("-");
    expect(_spinnerFrame(1_000, 1_750)).toBe("\\");
    expect(_spinnerFrame(1_000, 2_000)).toBe("|");
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
