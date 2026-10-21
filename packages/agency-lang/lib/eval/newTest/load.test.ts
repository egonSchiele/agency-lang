import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTestForm } from "./load.js";

describe("loadTestForm", () => {
  let suite: string;

  beforeEach(() => {
    suite = fs.mkdtempSync(path.join(os.tmpdir(), "eval-edit-"));
  });

  afterEach(() => {
    fs.rmSync(suite, { recursive: true, force: true });
  });

  function test(name: string, json: Record<string, unknown>, extra: Record<string, string> = {}) {
    const dir = path.join(suite, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "test.json"), JSON.stringify(json));
    for (const [rel, content] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }

  it("loads the five fields and locks the folder name and files rows", () => {
    const dir = test(
      "t",
      { description: "d", input: "ask", goal: "g" },
      { "files/a.txt": "a", "files/sub/b.txt": "b" },
    );
    const state = loadTestForm(dir);
    expect(state.values).toEqual({ id: "", description: "d", input: "ask", files: "", goal: "g" });
    expect(state.locks).toEqual({ id: "t", files: "files/ (2 files)" });
    expect(state.editing?.testDir).toBe(dir);
    expect(state.suiteDir).toBe(suite);
    expect(loadTestForm(test("u", { goal: "g" })).locks.files).toBe("none");
  });

  it("loads graders.json into drafts in order", () => {
    const graders = [
      { kind: "command", name: "runs", command: "true" },
      { kind: "count", name: "quiet", count: "errors", max: 0, mustPass: true },
    ];
    const dir = test("t", { goal: "g" }, { "graders.json": JSON.stringify(graders) });
    const state = loadTestForm(dir);
    expect(state.graders.map((draft) => draft.answers.kind)).toEqual(["command", "count"]);
    expect(state.graders[1].answers).toMatchObject({ name: "quiet", max: "0", mustPass: "yes" });
    expect(state.gradersLock).toBeNull();
  });

  it("locks the section for a graders.ts", () => {
    const state = loadTestForm(test("t", { goal: "g" }, { "graders.ts": "export default []" }));
    expect(state.gradersLock).toBe("graders.ts: edit the file");
    expect(state.graders).toEqual([]);
  });

  it("locks a structured input and keeps it in the base", () => {
    const state = loadTestForm(test("t", { input: { a: 1 }, goal: "g" }));
    expect(state.locks.input).toBe("structured input: edit the file");
    expect(state.values.input).toBe("");
    expect(state.editing?.base.input).toEqual({ a: 1 });
  });

  it("keeps keys the form does not show in the base", () => {
    const json = {
      goal: "g",
      tags: ["a"],
      timeoutSec: 5,
      expected: { x: 1 },
      metadata: { m: 1 },
      harnessMaxCost: 1,
      harnessMustPass: true,
    };
    expect(loadTestForm(test("t", json)).editing?.base).toEqual(json);
  });

  it("refuses an id that differs from the folder name", () => {
    expect(() => loadTestForm(test("t", { id: "other", goal: "g" }))).toThrow(
      /names id "other" but the folder is "t"; rename the folder or the id/,
    );
  });

  it("refuses a file, a folder with no test.json, and a non-object test.json", () => {
    const file = path.join(suite, "f.json");
    fs.writeFileSync(file, "{}");
    expect(() => loadTestForm(file)).toThrow(/is not a directory/);
    const empty = path.join(suite, "empty");
    fs.mkdirSync(empty);
    expect(() => loadTestForm(empty)).toThrow(/has no test.json; eval edit opens one test folder/);
    const list = path.join(suite, "list");
    fs.mkdirSync(list);
    fs.writeFileSync(path.join(list, "test.json"), "[]");
    expect(() => loadTestForm(list)).toThrow(/must contain a JSON object/);
  });

  it("opens a files directory with a symlink inside, or that is itself a symlink, saying it could not be read", () => {
    const inside = test("t", { goal: "g" }, { "files/a.txt": "a" });
    fs.symlinkSync(path.join(inside, "test.json"), path.join(inside, "files", "link"));
    expect(loadTestForm(inside).locks.files).toMatch(/^files\/ \(could not be read: .*symlink/);
    const itself = test("u", { goal: "g" }, { "elsewhere/a.txt": "a" });
    fs.symlinkSync(path.join(itself, "elsewhere"), path.join(itself, "files"));
    expect(loadTestForm(itself).locks.files).toMatch(/^files\/ \(could not be read: .*symlink/);
  });

  it("keeps a spelled-out id in the base", () => {
    expect(loadTestForm(test("t", { id: "t", goal: "g" })).editing?.base.id).toBe("t");
  });

  it("shows a files path the file names, and locks the section for a graders path elsewhere", () => {
    fs.mkdirSync(path.join(suite, "shared"));
    fs.writeFileSync(path.join(suite, "common.ts"), "export default []");
    const state = loadTestForm(
      test("t", { goal: "g", files: "../shared", graders: "../common.ts" }),
    );
    expect(state.locks.files).toBe("../shared");
    expect(state.gradersLock).toBe("../common.ts: edit the file");
    expect(state.graders).toEqual([]);
  });

  it("refuses a test with a rubric", () => {
    expect(() => loadTestForm(test("t", { rubric: "r" }))).toThrow(
      /test.json has a rubric; this form edits goal/,
    );
  });

  it("starts clean, on the first unlocked row", () => {
    const state = loadTestForm(test("t", { description: "d", goal: "g" }));
    expect(state.cursor).toEqual({ kind: "field", name: "description" });
  });
});
