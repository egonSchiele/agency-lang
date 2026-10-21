import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";

import { evalEdit, type EvalEditOptions } from "./edit.js";
import { ctrl, drive, shown, type Step } from "./formTestHarness.js";

const SIZE = { width: 100, height: 24 };

describe("evalEdit", () => {
  let suite: string;
  let testDir: string;
  let input: ScriptedInput;
  let recorder: FrameRecorder;
  let printed: string[];
  let opened: number;

  function options(): EvalEditOptions {
    return {
      testDir,
      openTerminal: () => {
        opened += 1;
        return { input, output: recorder, size: SIZE, openEditor: null };
      },
      print: (text) => printed.push(text),
    };
  }

  function run(steps: Step[]): Promise<void> {
    return drive(() => evalEdit(options()), input, recorder, steps);
  }

  function read(name: string): string {
    return fs.readFileSync(path.join(testDir, name), "utf8");
  }

  beforeEach(() => {
    suite = fs.mkdtempSync(path.join(os.tmpdir(), "eval-edit-cmd-"));
    testDir = path.join(suite, "says-its-name");
    fs.mkdirSync(path.join(testDir, "files"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "files", "a.txt"), "a");
    fs.writeFileSync(
      path.join(testDir, "test.json"),
      JSON.stringify({ description: "d", goal: "Says the name.", tags: ["t"] }),
    );
    input = new ScriptedInput();
    recorder = new FrameRecorder();
    printed = [];
    opened = 0;
  });

  afterEach(() => {
    fs.rmSync(suite, { recursive: true, force: true });
  });

  it("opens a test, edits the goal, and y writes it back with the other keys kept", async () => {
    await run([
      { when: shown("EDIT TEST"), key: "down" },
      { when: () => true, key: "down" },
      { when: shown("Says the name.█"), key: " " },
      { when: shown("Says the name. █"), key: "L" },
      { when: shown("Says the name. L█"), key: ctrl("s") },
      { when: shown("write this test?"), key: "y" },
    ]);
    expect(JSON.parse(read("test.json"))).toEqual({
      description: "d",
      goal: "Says the name. L",
      tags: ["t"],
    });
    expect(read("files/a.txt")).toBe("a");
    expect(printed[0]).toBe(`wrote ${testDir}`);
    expect(printed.some((line) => line.includes("--test says-its-name"))).toBe(true);
  });

  it("quits at once when nothing changed", async () => {
    await run([{ when: shown("EDIT TEST"), key: ctrl("c") }]);
    expect(printed).toEqual([]);
    expect(recorder.lastText()).not.toContain("discard this test?");
  });

  it("the folder name and files rows cannot take the cursor", async () => {
    await run([
      { when: shown("EDIT TEST"), key: "up" },
      { when: () => true, key: "x" },
      { when: shown("dx█"), key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "y" },
      { when: shown("Says the name.y█"), key: ctrl("c") },
      { when: shown("discard this test?"), key: "y" },
    ]);
    const text = recorder.frames.map((_, index) => recorder.textAt(index)).join("\n");
    expect(text).not.toContain("says-its-namex");
    expect(text).toMatch(/files\s+files\/ \(1 files\)/);
  });

  it("a test with graders.ts shows the lock and Ctrl+N does nothing", async () => {
    fs.writeFileSync(path.join(testDir, "graders.ts"), "export default []");
    await run([
      { when: shown("graders.ts: edit the file"), key: ctrl("n") },
      { when: () => true, key: ctrl("c") },
    ]);
    expect(recorder.lastText()).not.toContain("what to check");
    expect(printed).toEqual([]);
  });

  it("removing the only grader and saving deletes graders.json", async () => {
    fs.writeFileSync(
      path.join(testDir, "graders.json"),
      JSON.stringify([{ kind: "command", name: "runs", command: "true" }]),
    );
    await run([
      { when: shown("1. what to check"), key: "down" },
      { when: () => true, key: "down" },
      { when: () => true, key: "down" },
      { when: shown("Ctrl+X remove"), key: ctrl("x") },
      { when: shown("remove this grader?"), key: "y" },
      { when: shown("no graders:"), key: ctrl("s") },
      { when: shown("write this test?"), key: "y" },
    ]);
    expect(fs.existsSync(path.join(testDir, "graders.json"))).toBe(false);
    expect(JSON.parse(read("test.json")).goal).toBe("Says the name.");
  });

  it("refuses a mismatched id before opening the terminal", async () => {
    fs.writeFileSync(path.join(testDir, "test.json"), JSON.stringify({ id: "other", goal: "g" }));
    await expect(evalEdit(options())).rejects.toThrow(/names id "other"/);
    expect(opened).toBe(0);
  });
});
