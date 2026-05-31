import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _runLoop,
  _setInputSource,
  _setOutputTarget,
  _setSize,
  _hasActiveScreen,
  BottomRegionOutputTarget,
  _writeScrollLine,
} from "./ui.js";
import { installRegion, resetRegion } from "./ui-region.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";

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

  it("wraps the inner write in save+move+restore", () => {
    const innerWrites: string[] = [];
    const inner = {
      write(_frame: any) {
        innerWrites.push("INNER_FRAME");
      },
    };
    installRegion(3); // scrollBottom = 21 → bottom region starts at row 22
    stdoutWrites.length = 0;
    const target = new BottomRegionOutputTarget(inner as any);
    target.write({} as any);
    const out = stdoutWrites.join("");
    expect(out).toContain("\x1b[s"); // save cursor
    expect(out).toContain("\x1b[22;1H"); // move to bottom region
    expect(out).toContain("\x1b[u"); // restore cursor
    expect(innerWrites).toEqual(["INNER_FRAME"]);
  });

  it("forwards the label argument to the inner target", () => {
    const labels: (string | undefined)[] = [];
    const inner = {
      write(_frame: any, label?: string) {
        labels.push(label);
      },
    };
    installRegion(3);
    const target = new BottomRegionOutputTarget(inner as any);
    target.write({} as any, "my-label");
    expect(labels).toEqual(["my-label"]);
  });

  it("forwards destroy() to the inner target if present", () => {
    let destroyed = false;
    const inner = {
      write(_f: any) {},
      destroy() {
        destroyed = true;
      },
    };
    const target = new BottomRegionOutputTarget(inner as any);
    target.destroy();
    expect(destroyed).toBe(true);
  });

  it("destroy() tolerates inner targets without a destroy method", () => {
    const inner = { write(_f: any) {} };
    const target = new BottomRegionOutputTarget(inner as any);
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
