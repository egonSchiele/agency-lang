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
    return {
      suiteDir: suite,
      openTerminal: () => ({ input, output: recorder, size: SIZE, openEditor }),
    };
  }

  beforeEach(() => {
    suite = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-cmd-"));
    input = new ScriptedInput();
    recorder = new FrameRecorder();
  });

  afterEach(() => {
    fs.rmSync(suite, { recursive: true, force: true });
  });

  it("types into each field, Enter moves on, and Enter on goal writes the folder", async () => {
    const shown = (text: string) => (frame: string) => frame.includes(text);
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "s" },
      ...typing("ays-its-name"),
      { when: shown("says-its-name█"), key: "enter" },
      ...typing("The script is asked its name."),
      { when: shown("name.█"), key: "enter" },
      ...typing("What is your name?"),
      { when: shown("What is your name?█"), key: "enter" },
      { when: shown("Enter next"), key: "enter" },
      ...typing("Says the name."),
      { when: shown("Says the name.█"), key: "enter" },
      { when: shown("wrote "), key: "x" },
    ]);
    const json = JSON.parse(
      fs.readFileSync(path.join(suite, "says-its-name", "test.json"), "utf8"),
    );
    expect(json).toEqual({
      description: "The script is asked its name.",
      input: "What is your name?",
      goal: "Says the name.",
    });
    const text = recorder.lastText();
    expect(text).toContain("agency eval run <agent> --suite");
    expect(text.replace(/\s+/g, " ")).toContain("--test says-its-name");
  });

  it("the last field offers Enter save, the others Enter next", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("Enter next"), key: "up" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: (frame) => frame.includes("Enter save"), key: "escape" },
    ]);
  });

  it("Ctrl+S with no goal shows the problem, moves the cursor to it, and writes nothing", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: { key: "s", ctrl: true } },
      { when: (frame) => frame.includes("goal is required"), key: "escape" },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
  });

  it("Escape after typing asks first, and n returns to the form", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: "escape" },
      { when: (frame) => frame.includes("discard this test?"), key: "n" },
      { when: (frame) => frame.includes("Ctrl+S save"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
  });

  it("quits at once when nothing was typed", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "escape" },
    ]);
  });

  it("Ctrl+E on goal opens the editor when one is set, and takes its text", async () => {
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
      { when: (frame) => frame.includes("Ctrl+E editor"), key: { key: "e", ctrl: true } },
      { when: (frame) => frame.includes("paragraphs from the editor"), key: "up" },
      { when: (frame) => frame.includes("Two"), key: "escape" },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(opened).toEqual([""]);
  });

  it("Ctrl+E on a short field, or with no editor, does nothing", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: { key: "e", ctrl: true } },
      { when: (frame) => !frame.includes("Ctrl+E editor"), key: "escape" },
    ]);
    expect(recorder.lastText()).not.toContain("could not run the editor");
  });

  it("a failed save on the files field moves the cursor there", async () => {
    fs.mkdirSync(path.join(suite, "fixtures"));
    fs.symlinkSync(path.join(suite, "fixtures"), path.join(suite, "fixtures", "loop"));
    const shown = (text: string) => (frame: string) => frame.includes(text);
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "t" },
      { when: shown("t█"), key: "enter" },
      { when: () => true, key: "enter" },
      { when: () => true, key: "enter" },
      ...typing("fixtures"),
      { when: shown("fixtures█"), key: "enter" },
      ...typing("g"),
      { when: shown("g█"), key: "enter" },
      // The cursor is back on files, so typing lands there.
      { when: shown("files must not contain symlinks"), key: "2" },
      { when: shown("fixtures2█"), key: "escape" },
      { when: shown("discard this test?"), key: "y" },
    ]);
    expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
  });

  it("an editor that cannot run keeps the form and shows why", async () => {
    const editor: OpenEditor = () => {
      throw new Error("spawn vim ENOENT");
    };
    await drive(options(editor), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "down" },
      { when: () => true, key: "down" },
      { when: (frame) => frame.includes("Ctrl+E editor"), key: { key: "e", ctrl: true } },
      {
        when: (frame) => frame.includes("could not run the editor: spawn vim ENOENT"),
        key: "escape",
      },
    ]);
  });

  it("an editor that exits without saving leaves the field and says so", async () => {
    await drive(
      options(() => null),
      input,
      recorder,
      [
        { when: (frame) => frame.includes("NEW TEST"), key: "down" },
        { when: () => true, key: "down" },
        { when: (frame) => frame.includes("Ctrl+E editor"), key: { key: "e", ctrl: true } },
        { when: (frame) => frame.includes("editor exited without saving"), key: "escape" },
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

  it("evalNew checks the directory before opening the terminal", async () => {
    let opened = false;
    const bad = {
      suiteDir: path.join(dir, "missing"),
      openTerminal: () => {
        opened = true;
        throw new Error("terminal opened");
      },
    };
    await expect(evalNew(bad)).rejects.toThrow(/not a directory/);
    expect(opened).toBe(false);
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
