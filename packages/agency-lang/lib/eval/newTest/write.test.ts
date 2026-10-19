import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadInputs } from "@/eval/loadInputs.js";

import { initialForm, type FormState } from "./form.js";
import { nextCommands, testJsonFor, validateForm, writeTest, type FileChecks } from "./write.js";

const NOTHING_ON_DISK: FileChecks = { exists: () => false, isDirectory: () => false };

function form(suiteDir: string, values: Partial<FormState["values"]>): FormState {
  const base = initialForm(suiteDir);
  return { ...base, values: { ...base.values, ...values } };
}

describe("validateForm", () => {
  it("requires an id and a goal, in field order", () => {
    expect(validateForm(form("suite", {}), NOTHING_ON_DISK)).toEqual([
      { field: "id", text: "id is required" },
      { field: "goal", text: "goal is required" },
    ]);
  });

  it("refuses an id with a slash or a space", () => {
    for (const id of ["a/b", "a b", "../x"]) {
      const problems = validateForm(form("suite", { id, goal: "g" }), NOTHING_ON_DISK);
      expect(problems.map((problem) => problem.field)).toEqual(["id"]);
    }
  });

  it("refuses a test folder that already exists", () => {
    const checks: FileChecks = { exists: () => true, isDirectory: () => false };
    const problems = validateForm(form("suite", { id: "dup", goal: "g" }), checks);
    expect(problems[0].text).toContain("already exists");
  });

  it("refuses a files directory outside the suite or that is not a directory", () => {
    const outside = validateForm(form("suite", { id: "t", goal: "g", files: "../elsewhere" }), {
      exists: () => false,
      isDirectory: () => true,
    });
    expect(outside).toEqual([
      { field: "files", text: "files must be a directory inside the suite" },
    ]);
    const missing = validateForm(
      form("suite", { id: "t", goal: "g", files: "fixtures" }),
      NOTHING_ON_DISK,
    );
    expect(missing[0].text).toContain("is not a directory");
  });

  it("passes a complete form", () => {
    expect(validateForm(form("suite", { id: "t", goal: "g" }), NOTHING_ON_DISK)).toEqual([]);
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

  it("refuses a symlink inside files and writes nothing", () => {
    const fixtures = path.join(suite, "fixtures");
    fs.mkdirSync(fixtures);
    fs.writeFileSync(path.join(fixtures, "real.txt"), "R");
    fs.symlinkSync(path.join(fixtures, "real.txt"), path.join(fixtures, "link.txt"));
    expect(() => writeTest(form(suite, { id: "linked", goal: "g", files: "fixtures" }))).toThrow(
      /files must not contain symlinks/,
    );
    expect(fs.existsSync(path.join(suite, "linked"))).toBe(false);
  });

  it("replaces a stale staging folder and refuses an existing target", () => {
    fs.mkdirSync(path.join(suite, ".staging-t"));
    fs.writeFileSync(path.join(suite, ".staging-t", "junk"), "x");
    const dir = writeTest(form(suite, { id: "t", goal: "g" }));
    expect(fs.existsSync(path.join(dir, "junk"))).toBe(false);
    expect(() => writeTest(form(suite, { id: "t", goal: "g" }))).toThrow(/already exists/);
    expect(fs.existsSync(path.join(suite, ".staging-t"))).toBe(false);
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
