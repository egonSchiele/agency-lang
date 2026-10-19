import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import type { KeyEvent } from "@/tui/input/types.js";
import { FrameRecorder } from "@/tui/output/recorder.js";

import { assertSuiteDirectory, evalNew, type EvalNewOptions, type OpenEditor } from "./new.js";

const SIZE = { width: 100, height: 24 };

type Step = { when: (frame: string) => boolean; key: KeyEvent | string };

function lastFrame(recorder: FrameRecorder): string {
  return recorder.frames.length === 0 ? "" : recorder.lastText();
}

/** Run the form while a poller feeds each key once the screen shows the
 *  state a person would react to. */
async function drive(
  options: EvalNewOptions,
  input: ScriptedInput,
  recorder: FrameRecorder,
  steps: Step[],
) {
  let at = 0;
  const timer = setInterval(() => {
    if (at < steps.length && steps[at].when(lastFrame(recorder))) {
      const key = steps[at].key;
      input.feedKey(typeof key === "string" ? { key } : key);
      at += 1;
    }
  }, 1);
  try {
    await evalNew(options);
  } finally {
    clearInterval(timer);
  }
  expect(at).toBe(steps.length);
}

function typing(text: string): Step[] {
  return [...text].map((key) => ({ when: () => true, key }));
}

describe("evalNew", () => {
  let suite: string;
  let input: ScriptedInput;
  let recorder: FrameRecorder;

  function options(openEditor: OpenEditor = null): EvalNewOptions {
    return { suiteDir: suite, input, output: recorder, size: SIZE, openEditor };
  }

  beforeEach(() => {
    suite = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-cmd-"));
    input = new ScriptedInput();
    recorder = new FrameRecorder();
  });

  afterEach(() => {
    fs.rmSync(suite, { recursive: true, force: true });
  });

  it("fills the fields by key, saves, and writes the folder", async () => {
    const shown = (text: string) => (frame: string) => frame.includes(text);
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "enter" },
      ...typing("says-its-name"),
      { when: shown("says-its-name█"), key: "enter" },
      { when: (frame) => !frame.includes("█"), key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "enter" },
      ...typing("What is your name?"),
      { when: shown("What is your name?█"), key: "enter" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "enter" },
      ...typing("Says the name."),
      { when: shown("Says the name.█"), key: "enter" },
      { when: (frame) => frame.includes("goal") && !frame.includes("█"), key: "s" },
      { when: shown("wrote "), key: "x" },
    ]);
    const json = JSON.parse(
      fs.readFileSync(path.join(suite, "says-its-name", "test.json"), "utf8"),
    );
    expect(json).toEqual({ input: "What is your name?", goal: "Says the name." });
    const text = recorder.lastText();
    expect(text).toContain("agency eval run <agent> --suite");
    expect(text.replace(/\s+/g, " ")).toContain("--test says-its-name");
  });

  it("s with no goal shows the problem, moves the cursor to it, and writes nothing", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "enter" },
      ...typing("t"),
      { when: (frame) => frame.includes("t█"), key: "enter" },
      { when: (frame) => !frame.includes("█"), key: "s" },
      { when: (frame) => frame.includes("goal is required"), key: "q" },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
  });

  it("q after typing asks first, and n returns to the form", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "enter" },
      ...typing("t"),
      { when: (frame) => frame.includes("t█"), key: "enter" },
      { when: (frame) => !frame.includes("█"), key: "q" },
      { when: (frame) => frame.includes("discard this test?"), key: "n" },
      { when: (frame) => frame.includes("s save"), key: "q" },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
  });

  it("quits at once when nothing was typed", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "q" },
    ]);
  });

  it("Enter on goal opens the editor when one is set, and takes its text", async () => {
    const opened: string[] = [];
    const editor: OpenEditor = (text) => {
      opened.push(text);
      return "Two\nparagraphs from the editor";
    };
    await drive(options(editor), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "enter" },
      { when: (frame) => frame.includes("paragraphs from the editor"), key: "q" },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(opened).toEqual([""]);
  });

  it("an editor that exits without saving leaves the field and says so", async () => {
    await drive(
      options(() => null),
      input,
      recorder,
      [
        { when: (frame) => frame.includes("NEW TEST"), key: "down" },
        { when: () => true, key: "down" },
        { when: () => true, key: "enter" },
        { when: (frame) => frame.includes("editor exited without saving"), key: "q" },
      ],
    );
  });
});

describe("assertSuiteDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-suite-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an empty directory and one of test folders", () => {
    expect(() => assertSuiteDirectory(dir)).not.toThrow();
    fs.mkdirSync(path.join(dir, "a"));
    fs.writeFileSync(path.join(dir, "a", "test.json"), "{}");
    expect(() => assertSuiteDirectory(dir)).not.toThrow();
  });

  it("refuses a file, a single test folder, and the JSON file form", () => {
    expect(() => assertSuiteDirectory(path.join(dir, "missing"))).toThrow(/not a directory/);
    const one = path.join(dir, "one");
    fs.mkdirSync(one);
    fs.writeFileSync(path.join(one, "test.json"), "{}");
    expect(() => assertSuiteDirectory(one)).toThrow(/one test, not a suite/);
    fs.writeFileSync(path.join(dir, "suite.json"), "{}");
    expect(() => assertSuiteDirectory(dir)).toThrow(/suite.json/);
  });
});
