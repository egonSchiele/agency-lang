import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadGradersJson } from "@/eval/gradersJson/load.js";
import { loadInputs } from "@/eval/loadInputs.js";

import { initialForm, type FormState, type Row } from "./form.js";
import type { Answers } from "./graders.js";
import {
  gradersJsonText,
  nextCommands,
  testJsonFor,
  TestWriteError,
  validateForm,
  writeTest,
  type FileChecks,
} from "./write.js";

const NOTHING_ON_DISK: FileChecks = {
  exists: () => false,
  isDirectory: () => false,
  realPath: (file) => file,
};

function form(
  suiteDir: string,
  values: Partial<FormState["values"]>,
  graders: Answers[] = [],
): FormState {
  const base = initialForm(suiteDir);
  return {
    ...base,
    values: { ...base.values, ...values },
    graders: graders.map((answers) => ({ answers })),
  };
}

function graderRow(index: number, question: string): Row {
  return { kind: "grader", index, question };
}

const COMMAND_GRADER: Answers = { kind: "command", command: "true", name: "runs" };

describe("validateForm", () => {
  it("requires an id and a goal, in field order", () => {
    expect(validateForm(form("suite", {}), NOTHING_ON_DISK)).toEqual([
      { row: { kind: "field", name: "id" }, text: "folder name is required" },
      { row: { kind: "field", name: "goal" }, text: "goal is required" },
    ]);
  });

  it("refuses an id with a slash or a space", () => {
    for (const id of ["a/b", "a b", "../x"]) {
      const problems = validateForm(form("suite", { id, goal: "g" }), NOTHING_ON_DISK);
      expect(problems.map((problem) => problem.row)).toEqual([{ kind: "field", name: "id" }]);
    }
  });

  it("refuses a test folder that already exists", () => {
    const checks: FileChecks = { ...NOTHING_ON_DISK, exists: () => true };
    const problems = validateForm(form("suite", { id: "dup", goal: "g" }), checks);
    expect(problems[0].text).toContain("already exists");
  });

  it("refuses a files directory outside the suite or that is not a directory", () => {
    const anyDirectory: FileChecks = { ...NOTHING_ON_DISK, isDirectory: () => true };
    for (const files of ["../elsewhere", ".", "/tmp", "a/../.."]) {
      expect(validateForm(form("suite", { id: "t", goal: "g", files }), anyDirectory)).toEqual([
        {
          row: { kind: "field", name: "files" },
          text: "files must be a directory inside the suite",
        },
      ]);
    }
    // A name that merely starts with two dots is inside the suite.
    expect(
      validateForm(form("suite", { id: "t", goal: "g", files: "..cache" }), anyDirectory),
    ).toEqual([]);
    const missing = validateForm(
      form("suite", { id: "t", goal: "g", files: "fixtures" }),
      NOTHING_ON_DISK,
    );
    expect(missing[0].text).toContain("is not a directory");
  });

  it("refuses a files directory reached through a symlink", () => {
    const linked: FileChecks = {
      ...NOTHING_ON_DISK,
      isDirectory: () => true,
      realPath: (file) => (file.endsWith("link") ? "/elsewhere/real" : file),
    };
    const problems = validateForm(form("/suite", { id: "t", goal: "g", files: "link" }), linked);
    expect(problems).toEqual([
      {
        row: { kind: "field", name: "files" },
        text: "files must not be reached through a symlink: /suite/link",
      },
    ]);
  });

  it("passes a complete form", () => {
    expect(validateForm(form("suite", { id: "t", goal: "g" }), NOTHING_ON_DISK)).toEqual([]);
  });

  it("a goal is not required once the test has a grader", () => {
    expect(validateForm(form("suite", { id: "t" }, [COMMAND_GRADER]), NOTHING_ON_DISK)).toEqual([]);
  });

  it("an unpicked kind is one problem on the kind row, in the parser's words", () => {
    expect(validateForm(form("suite", { id: "t" }, [{}]), NOTHING_ON_DISK)).toEqual([
      { row: graderRow(0, "kind"), text: 'unknown kind ""' },
    ]);
  });

  it("a non-number and a missing name are named by row, with the parser's words", () => {
    const badMax = form("suite", { id: "t" }, [{ kind: "count", max: "ten", name: "n" }]);
    const [problem] = validateForm(badMax, NOTHING_ON_DISK);
    expect(problem.row).toEqual(graderRow(0, "max"));
    expect(problem.text).toContain("max");
    const noName = form("suite", { id: "t" }, [{ kind: "count", max: "1" }]);
    expect(validateForm(noName, NOTHING_ON_DISK)[0].row).toEqual(graderRow(0, "name"));
  });

  it("an empty checklist lands on its first point row", () => {
    const state = form("suite", { id: "t" }, [{ kind: "checklist", name: "c" }]);
    const [problem] = validateForm(state, NOTHING_ON_DISK);
    expect(problem.row).toEqual(graderRow(0, "point.0"));
    expect(problem.text).toContain("points");
  });

  it("a cross-field rule from the parser lands on the kind row with the parser's words", () => {
    const state = form("suite", { id: "t" }, [
      {
        kind: "number",
        measure: "llmCalls",
        scoring: "between",
        full: "0",
        zero: "9",
        mustPass: "yes",
        name: "n",
      },
    ]);
    expect(validateForm(state, NOTHING_ON_DISK)).toEqual([
      { row: graderRow(0, "kind"), text: "a must-pass number grader needs max" },
    ]);
  });

  it("a parser field problem lands on its row", () => {
    const state = form("suite", { id: "t" }, [
      { kind: "goal", goal: "g", name: "n", mustPass: "yes", passingScore: "2" },
    ]);
    const [problem] = validateForm(state, NOTHING_ON_DISK);
    expect(problem.row).toEqual(graderRow(0, "passingScore"));
    expect(problem.text).toContain("passingScore");
  });

  it("two graders with one name are reported on the second", () => {
    const state = form("suite", { id: "t" }, [COMMAND_GRADER, { ...COMMAND_GRADER }]);
    expect(validateForm(state, NOTHING_ON_DISK)).toEqual([
      { row: graderRow(1, "name"), text: 'two graders named "runs"' },
    ]);
  });
});

describe("testJsonFor", () => {
  it("writes only the fields with values and never files", () => {
    expect(testJsonFor({ id: "t", description: "", input: "", files: "./f", goal: "g" })).toEqual({
      goal: "g",
    });
    expect(testJsonFor({ id: "t", description: "d", input: "ask", files: "", goal: "g" })).toEqual({
      description: "d",
      input: "ask",
      goal: "g",
    });
  });
});

describe("writeTest", () => {
  let suite: string;

  beforeEach(() => {
    suite = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-"));
  });

  afterEach(() => {
    fs.rmSync(suite, { recursive: true, force: true });
  });

  it("writes test.json byte for byte and the loader reads it back", () => {
    const state = form(suite, {
      id: "says-its-name",
      description: "The script is told its name.",
      input: "What's your name?",
      goal: "The reply says the name.",
    });
    const dir = writeTest(state);
    expect(dir).toBe(path.join(suite, "says-its-name"));
    expect(fs.readFileSync(path.join(dir, "test.json"), "utf8")).toBe(
      '{\n  "description": "The script is told its name.",\n  "input": "What\'s your name?",\n  "goal": "The reply says the name."\n}\n',
    );
    const [test] = loadInputs(suite);
    expect(test.id).toBe("says-its-name");
    expect(test.goal).toBe("The reply says the name.");
    expect(test.input).toBe("What's your name?");
    expect(fs.existsSync(path.join(suite, ".staging-says-its-name"))).toBe(false);
  });

  it("writes graders.json beside test.json, and the loader builds the graders", async () => {
    const state = form(suite, { id: "graded" }, [
      COMMAND_GRADER,
      { kind: "count", count: "errors", max: "0", name: "no-errors", mustPass: "yes" },
    ]);
    const dir = writeTest(state);
    const [test] = loadInputs(suite);
    expect(test.graders).toBe(path.join(dir, "graders.json"));
    expect(test.goal).toBeUndefined();
    const graders = await loadGradersJson(path.join(dir, "graders.json"));
    expect(graders.map((grader) => grader.name())).toEqual(["runs", "no-errors"]);
    expect(fs.readFileSync(path.join(dir, "graders.json"), "utf8")).toBe(
      gradersJsonText(state.graders),
    );
  });

  it("writes no graders.json when there are no graders", () => {
    const dir = writeTest(form(suite, { id: "plain", goal: "g" }));
    expect(fs.existsSync(path.join(dir, "graders.json"))).toBe(false);
  });

  it("leaves an empty input out, so the loader reads a test that takes none", () => {
    writeTest(form(suite, { id: "no-input", goal: "g" }));
    const [test] = loadInputs(suite);
    expect(test.input).toBeUndefined();
  });

  it("copies the files directory, keeping nested paths", () => {
    const fixtures = path.join(suite, "fixtures");
    fs.mkdirSync(path.join(fixtures, "deep"), { recursive: true });
    fs.writeFileSync(path.join(fixtures, "a.txt"), "A");
    fs.writeFileSync(path.join(fixtures, "deep", "b.txt"), "B");
    const dir = writeTest(form(suite, { id: "with-files", goal: "g", files: "fixtures" }));
    expect(fs.readFileSync(path.join(dir, "files", "a.txt"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(dir, "files", "deep", "b.txt"), "utf8")).toBe("B");
    const [test] = loadInputs(dir);
    // The temp root is a symlink on macOS; compare real paths.
    expect(fs.realpathSync(test.files ?? "")).toBe(fs.realpathSync(path.join(dir, "files")));
  });

  it("copies a binary file byte for byte", () => {
    const fixtures = path.join(suite, "fixtures");
    fs.mkdirSync(fixtures);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
    fs.writeFileSync(path.join(fixtures, "logo.png"), bytes);
    const dir = writeTest(form(suite, { id: "binary", goal: "g", files: "fixtures" }));
    expect(fs.readFileSync(path.join(dir, "files", "logo.png"))).toEqual(bytes);
  });

  it("keeps an empty files directory as an empty files folder", () => {
    fs.mkdirSync(path.join(suite, "fixtures"));
    const dir = writeTest(form(suite, { id: "empty", goal: "g", files: "fixtures" }));
    expect(fs.readdirSync(path.join(dir, "files"))).toEqual([]);
  });

  it("refuses a symlink inside files, names the field, and leaves no staging folder", () => {
    const fixtures = path.join(suite, "fixtures");
    fs.mkdirSync(fixtures);
    fs.writeFileSync(path.join(fixtures, "real.txt"), "R");
    fs.symlinkSync(path.join(fixtures, "real.txt"), path.join(fixtures, "link.txt"));
    let thrown: unknown;
    try {
      writeTest(form(suite, { id: "linked", goal: "g", files: "fixtures" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TestWriteError);
    expect((thrown as TestWriteError).row).toEqual({ kind: "field", name: "files" });
    expect((thrown as TestWriteError).message).toMatch(/files must not contain symlinks/);
    expect(fs.readdirSync(suite)).toEqual(["fixtures"]);
  });

  it("refuses a files directory that is itself a symlink, even to a place inside the suite", () => {
    const real = path.join(suite, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "a.txt"), "A");
    fs.symlinkSync(real, path.join(suite, "link"));
    expect(() => writeTest(form(suite, { id: "t", goal: "g", files: "link" }))).toThrow(
      /files must not be reached through a symlink/,
    );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-outside-"));
    try {
      fs.symlinkSync(outside, path.join(suite, "away"));
      expect(() => writeTest(form(suite, { id: "t", goal: "g", files: "away/." }))).toThrow(
        /files must not be reached through a symlink/,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
  });

  it("replaces a stale staging folder and refuses an existing target", () => {
    fs.mkdirSync(path.join(suite, ".staging-t"));
    fs.writeFileSync(path.join(suite, ".staging-t", "junk"), "x");
    const dir = writeTest(form(suite, { id: "t", goal: "g" }));
    expect(fs.existsSync(path.join(dir, "junk"))).toBe(false);
    expect(() => writeTest(form(suite, { id: "t", goal: "g" }))).toThrow(/already exists/);
    expect(fs.existsSync(path.join(suite, ".staging-t"))).toBe(false);
  });

  it("stops when the stale staging path cannot be removed, instead of writing through it", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-new-outside-"));
    try {
      fs.symlinkSync(outside, path.join(suite, ".staging-t"));
      expect(() => writeTest(form(suite, { id: "t", goal: "g" }))).toThrow(/not strictly inside/);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(suite, "t"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    fs.rmSync(path.join(suite, ".staging-t"));
    fs.writeFileSync(path.join(suite, ".staging-t"), "a file");
    expect(() => writeTest(form(suite, { id: "t", goal: "g" }))).toThrow(/Not a directory/);
  });
});

describe("nextCommands", () => {
  it("names the suite and the test", () => {
    expect(nextCommands("bar-evals", "says-its-name")).toEqual([
      "agency eval run <agent> --suite bar-evals --test says-its-name --out runs/<name>",
      "agency eval grade runs/<name>",
    ]);
  });
});
