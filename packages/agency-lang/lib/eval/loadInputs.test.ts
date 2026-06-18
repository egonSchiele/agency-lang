import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadInputs, loadInputsFromFile, inputFromGoal } from "./loadInputs.js";

describe("eval run input loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-load-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(relativePath: string, value: unknown): string {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
    return filePath;
  }

  it("loads inputs from a suite file and fills defaults", () => {
    const suitePath = writeJson("suite.json", {
      inputs: [{ goal: "do it", args: { prompt: "x" } }],
    });

    expect(loadInputsFromFile(suitePath, () => "generated-id")).toEqual([
      { id: "generated-id", goal: "do it", args: { prompt: "x" } },
    ]);
  });

  it("allows a missing goal when requireGoal is false and preserves metadata", () => {
    const suitePath = writeJson("no-goal.json", {
      inputs: [{ id: "a", args: { country: "Brazil" }, metadata: { expected: "Brasília" } }],
    });
    const inputs = loadInputsFromFile(suitePath, () => "a", { requireGoal: false });
    expect(inputs[0].goal).toBeUndefined();
    expect(inputs[0].metadata).toEqual({ expected: "Brasília" });
  });

  it("still requires a non-empty goal by default", () => {
    const suitePath = writeJson("needs-goal.json", { inputs: [{ id: "a", args: {} }] });
    expect(() => loadInputsFromFile(suitePath, () => "a")).toThrow(/goal must be a non-empty string/);
  });

  it("validates required goals and input ids", () => {
    expect(() => loadInputsFromFile(writeJson("missing-goal.json", { inputs: [{}] }))).toThrow(/goal/i);
    expect(() => loadInputsFromFile(writeJson("bad-id.json", { inputs: [{ id: "bad/id", goal: "x" }] }))).toThrow(/invalid id/i);
    expect(() => loadInputsFromFile(writeJson("duplicate-id.json", { inputs: [{ id: "same", goal: "a" }, { id: "same", goal: "b" }] }))).toThrow(/duplicate/i);
  });

  it("rejects rubric-shaped input files", () => {
    expect(() => loadInputsFromFile(writeJson("rubric-only.json", { inputs: [{ rubric: "x" }] }))).toThrow(/goal/i);
    expect(() => loadInputsFromFile(writeJson("goal-and-rubric.json", { inputs: [{ goal: "x", rubric: "y" }] }))).toThrow(/both goal and rubric/i);
  });

  it("allows an empty suite", () => {
    expect(loadInputsFromFile(writeJson("empty.json", { inputs: [] }))).toEqual([]);
  });

  it("loads input files from a directory in lexical order", () => {
    writeJson("suite/b.json", { id: "b", goal: "B", working_dir: "fixtures/b" });
    writeJson("suite/a.json", { id: "a", goal: "A", args: { n: 1 } });

    const inputs = loadInputs(path.join(tmpDir, "suite"));

    expect(inputs.map((input) => input.id)).toEqual(["a", "b"]);
    expect(inputs[0].args).toEqual({ n: 1 });
    expect(inputs[1].working_dir).toBe(path.join(tmpDir, "suite", "fixtures/b"));
  });

  it("returns an empty list for a directory with no json files", () => {
    fs.mkdirSync(path.join(tmpDir, "empty"));
    fs.writeFileSync(path.join(tmpDir, "empty", "note.txt"), "ignore me");

    expect(loadInputs(path.join(tmpDir, "empty"))).toEqual([]);
  });

  it("creates an inline input from a goal", () => {
    expect(inputFromGoal("do it")).toEqual({
      id: "input-1",
      goal: "do it",
      args: {},
    });
  });
});
