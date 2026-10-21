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
  let printed: string[];

  function options(openEditor: OpenEditor = null, size = SIZE): EvalNewOptions {
    return {
      suiteDir: suite,
      openTerminal: () => ({ input, output: recorder, size, openEditor }),
      print: (text) => printed.push(text),
    };
  }

  const shown = (text: string) => (frame: string) => frame.includes(text);
  const ctrl = (key: string): KeyEvent => ({ key, ctrl: true });
  const times = (key: string, count: number): Step[] =>
    Array.from({ length: count }, () => ({ when: () => true, key }));
  const everFrame = (text: string) =>
    recorder.frames.some((_, index) => recorder.textAt(index).includes(text));
  const graders = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(suite, id, "graders.json"), "utf8"));

  beforeEach(() => {
    suite = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-cmd-"));
    input = new ScriptedInput();
    recorder = new FrameRecorder();
    printed = [];
  });

  afterEach(() => {
    fs.rmSync(suite, { recursive: true, force: true });
  });

  it("types into each field, Enter moves on, and Enter on goal asks, then writes the folder", async () => {
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
      // A second Enter is not an answer: the question needs a y.
      { when: shown("write this test?"), key: "enter" },
      { when: shown("write this test?"), key: "y" },
    ]);
    const json = JSON.parse(
      fs.readFileSync(path.join(suite, "says-its-name", "test.json"), "utf8"),
    );
    expect(json).toEqual({
      description: "The script is asked its name.",
      input: "What is your name?",
      goal: "Says the name.",
    });
    // Printed once the screen is gone, where it stays in the scrollback.
    expect(printed[0]).toBe(`wrote ${path.join(suite, "says-its-name")}`);
    expect(printed.some((line) => line.includes("agency eval run <agent> --suite"))).toBe(true);
    expect(printed.some((line) => line.includes("--test says-its-name"))).toBe(true);
  });

  it("n to the save question returns to the form with nothing written", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: { key: "s", ctrl: true } },
      { when: (frame) => frame.includes("goal is required"), key: "g" },
      { when: (frame) => frame.includes("g█"), key: { key: "s", ctrl: true } },
      { when: (frame) => frame.includes("write this test?"), key: "n" },
      { when: (frame) => frame.includes("Enter save"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
    expect(printed).toEqual([]);
  });

  it("a second Ctrl+C does not answer the discard question", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "n" },
      { when: (frame) => frame.includes("t█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
  });

  it("an arrow key clears a failed save's message and brings the hints back", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: { key: "s", ctrl: true } },
      { when: (frame) => frame.includes("folder name is required"), key: "down" },
      { when: (frame) => frame.includes("Enter next"), key: { key: "c", ctrl: true } },
    ]);
  });

  it("a long value wraps on the cursor row and keeps the cursor at its end", async () => {
    const long =
      "a goal that is long enough to need a second row on a hundred column screen, and then a few more words, twice";
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      ...typing(long),
      { when: (frame) => frame.includes("twice█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    const shown = recorder.frames
      .map((_, index) => recorder.textAt(index))
      .find((text) => text.includes("twice█"));
    expect(shown).toBeDefined();
    // The value is wider than the row, so it continues on the next line.
    expect(shown).not.toContain(long);
  });

  it("the last field offers Enter save, the others Enter next", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("Enter next"), key: "up" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: (frame) => frame.includes("Enter save"), key: { key: "c", ctrl: true } },
    ]);
  });

  it("Ctrl+S with no goal shows the problem, moves the cursor to it, and writes nothing", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: { key: "s", ctrl: true } },
      { when: (frame) => frame.includes("goal is required"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
  });

  it("Ctrl+C after typing asks first, and n returns to the form", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "n" },
      { when: (frame) => frame.includes("Ctrl+S save"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
  });

  it("quits at once when nothing was typed", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: { key: "c", ctrl: true } },
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
      { when: (frame) => frame.includes("Two"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(opened).toEqual([""]);
  });

  it("Ctrl+E on a short field never opens the editor", async () => {
    let opened = 0;
    const editor: OpenEditor = () => {
      opened += 1;
      return "from the editor";
    };
    await drive(options(editor), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: { key: "e", ctrl: true } },
      { when: () => true, key: "t" },
      { when: (frame) => frame.includes("t█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    expect(opened).toBe(0);
    expect(recorder.lastText()).not.toContain("from the editor");
  });

  it("Ctrl+E on a long field with no editor set does nothing", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: (frame) => frame.includes("Enter save"), key: { key: "e", ctrl: true } },
      { when: () => true, key: "g" },
      { when: (frame) => frame.includes("g█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
    const text = recorder.lastText();
    expect(text).not.toContain("Ctrl+E editor");
    expect(text).not.toContain("could not run the editor");
  });

  it("a bare Escape and an Alt chord type nothing and do not quit", async () => {
    await drive(options(), input, recorder, [
      { when: (frame) => frame.includes("NEW TEST"), key: "t" },
      { when: (frame) => frame.includes("t█"), key: "escape" },
      { when: () => true, key: { key: "b", alt: true } },
      { when: () => true, key: "x" },
      { when: (frame) => frame.includes("tx█"), key: { key: "c", ctrl: true } },
      { when: (frame) => frame.includes("discard this test?"), key: "y" },
    ]);
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
      { when: shown("write this test?"), key: "y" },
      // The cursor is back on files, so typing lands there.
      { when: shown("files must not contain symlinks"), key: "2" },
      { when: shown("fixtures2█"), key: { key: "c", ctrl: true } },
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
        key: { key: "c", ctrl: true },
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
        {
          when: (frame) => frame.includes("editor exited without saving"),
          key: { key: "c", ctrl: true },
        },
      ],
    );
  });

  it("Ctrl+N adds a grader, Right picks a kind, the questions appear, and y writes graders.json", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "t" },
      ...times("enter", 4),
      { when: shown("Enter save"), key: "g" },
      { when: shown("g█"), key: ctrl("n") },
      { when: shown("1. what to check"), key: "right" },
      ...times("right", 3),
      { when: shown("count things in the trace"), key: "enter" },
      { when: shown("←→ pick"), key: "right" },
      { when: shown("errors"), key: "enter" },
      { when: shown("message starts with"), key: "U" },
      ...typing("nknown named argument"),
      { when: shown("argument█"), key: "enter" },
      { when: shown("at most"), key: "0" },
      { when: shown("0█"), key: "enter" },
      ...typing("no-bad-arguments"),
      { when: shown("no-bad-arguments█"), key: "enter" },
      { when: shown("Enter next"), key: "enter" },
      { when: shown("Enter save"), key: "enter" },
      { when: shown("write this test?"), key: "y" },
    ]);
    expect(everFrame("pick with ← →")).toBe(true);
    expect(graders("t")).toEqual([
      {
        kind: "count",
        name: "no-bad-arguments",
        count: "errors",
        messageStartsWith: "Unknown named argument",
        max: 0,
      },
    ]);
  });

  it("letters on a choice row type nothing and the hints offer ←→ pick", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: ctrl("n") },
      { when: shown("←→ pick"), key: "s" },
      { when: shown("←→ pick"), key: ctrl("c") },
      { when: shown("discard this test?"), key: "y" },
    ]);
    expect(everFrame("s█")).toBe(false);
    expect(everFrame("pick with ← →")).toBe(true);
  });

  it("Ctrl+X on a kind row asks, y removes, and the no-graders line is back", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: ctrl("n") },
      { when: shown("Ctrl+X remove"), key: ctrl("x") },
      { when: shown("remove this grader?"), key: "y" },
      { when: shown("no graders:"), key: ctrl("c") },
    ]);
    expect(printed).toEqual([]);
  });

  it("Ctrl+X elsewhere does nothing", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: ctrl("n") },
      { when: shown("Ctrl+X remove"), key: "right" },
      { when: shown("judge the reply against a goal"), key: "enter" },
      { when: shown("what a good reply does"), key: ctrl("x") },
      { when: () => true, key: ctrl("c") },
      { when: shown("discard this test?"), key: "y" },
    ]);
    expect(everFrame("remove this grader?")).toBe(false);
  });

  it("a save with a missing name lands the cursor on the name row", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "t" },
      { when: shown("t█"), key: ctrl("n") },
      { when: shown("Ctrl+X remove"), key: "right" },
      { when: shown("judge the reply against a goal"), key: "enter" },
      { when: shown("what a good reply does"), key: "g" },
      { when: shown("g█"), key: ctrl("s") },
      { when: (frame) => /name: /.test(frame), key: ctrl("c") },
      { when: shown("discard this test?"), key: "y" },
    ]);
    const failed = recorder.frames
      .map((_, index) => recorder.textAt(index))
      .find((text) => /name: /.test(text));
    expect(failed).toMatch(/name\s+█ letters, digits, - and _/);
  });

  it("a tall form scrolls to keep the cursor row on screen, and Up brings the fields back", async () => {
    await drive(options(null, { width: 100, height: 12 }), input, recorder, [
      { when: shown("NEW TEST"), key: ctrl("n") },
      { when: shown("Ctrl+X remove"), key: "right" },
      { when: shown("judge the reply against a goal"), key: "enter" },
      ...times("enter", 3),
      { when: (frame) => frame.includes("weight") && !frame.includes("folder name"), key: "up" },
      ...times("up", 20),
      { when: shown("folder name"), key: ctrl("c") },
      { when: shown("discard this test?"), key: "y" },
    ]);
  });

  it("a test with a grader and no goal saves", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "t" },
      { when: shown("t█"), key: ctrl("n") },
      { when: shown("Ctrl+X remove"), key: "right" },
      ...times("right", 4),
      { when: shown("run a command over the agent"), key: "enter" },
      { when: shown("runs in the agent"), key: "l" },
      ...typing("s"),
      { when: shown("ls█"), key: "enter" },
      { when: shown("600 (optional)"), key: "enter" },
      { when: shown("letters, digits, - and _"), key: "r" },
      ...typing("uns"),
      { when: shown("runs█"), key: ctrl("s") },
      { when: shown("write this test?"), key: "y" },
    ]);
    const json = JSON.parse(fs.readFileSync(path.join(suite, "t", "test.json"), "utf8"));
    expect(json.goal).toBeUndefined();
    expect(graders("t")).toEqual([{ kind: "command", name: "runs", command: "ls" }]);
  });

  it("a test with a grader and a goal saves, and the goal row said it is not judged", async () => {
    await drive(options(), input, recorder, [
      { when: shown("NEW TEST"), key: "t" },
      ...times("enter", 4),
      { when: shown("Enter save"), key: "g" },
      { when: shown("g█"), key: ctrl("n") },
      { when: shown("not judged while the test has graders"), key: "right" },
      ...times("right", 4),
      { when: shown("run a command over the agent"), key: "enter" },
      { when: shown("runs in the agent"), key: "l" },
      ...typing("s"),
      { when: shown("ls█"), key: "enter" },
      { when: shown("600 (optional)"), key: "enter" },
      { when: shown("letters, digits, - and _"), key: "r" },
      ...typing("uns"),
      { when: shown("runs█"), key: ctrl("s") },
      { when: shown("write this test?"), key: "y" },
    ]);
    const json = JSON.parse(fs.readFileSync(path.join(suite, "t", "test.json"), "utf8"));
    expect(json.goal).toBe("g");
    expect(graders("t")).toHaveLength(1);
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
    const bad: EvalNewOptions = {
      suiteDir: path.join(dir, "missing"),
      openTerminal: () => {
        opened = true;
        throw new Error("terminal opened");
      },
      print: () => {},
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
