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

  it("passes a first-class expected output through", () => {
    const suitePath = writeJson("with-expected.json", {
      inputs: [{ id: "india", args: { country: "India" }, expected: "New Delhi" }],
    });
    const inputs = loadInputsFromFile(suitePath, () => "india", { requireGoal: false });
    expect(inputs[0].expected).toBe("New Delhi");
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

describe("files field", () => {
  it("resolves files relative to the inputs file and requires a directory", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.mkdirSync(path.join(suiteDir, "fixtures", "report"), { recursive: true });
    fs.writeFileSync(path.join(suiteDir, "fixtures", "report", "q3.txt"), "data");
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "./fixtures/report" }],
    }));

    const [input] = loadInputs(inputsFile);

    expect(input.files).toBe(fs.realpathSync(path.join(suiteDir, "fixtures", "report")));
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("rejects a files value that is not a directory", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.writeFileSync(path.join(suiteDir, "not-a-dir.txt"), "x");
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "./not-a-dir.txt" }],
    }));

    expect(() => loadInputs(inputsFile)).toThrow(/files must name a directory/i);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("rejects files combined with working_dir", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.mkdirSync(path.join(suiteDir, "fixture-dir"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "./fixture-dir", working_dir: "./fixture-dir" }],
    }));

    expect(() => loadInputs(inputsFile)).toThrow(/files.*working_dir/i);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});

describe("test directories (heavy form)", () => {
  function makeSuite(): string {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.mkdirSync(path.join(suiteDir, "capital-france"));
    fs.writeFileSync(path.join(suiteDir, "capital-france", "test.json"),
      JSON.stringify({ goal: "Return the capital of France", args: {}, expected: "Paris" }));
    fs.mkdirSync(path.join(suiteDir, "summarize", "files", "data"), { recursive: true });
    fs.writeFileSync(path.join(suiteDir, "summarize", "test.json"),
      JSON.stringify({ goal: "Summarize the report", args: {} }));
    fs.writeFileSync(path.join(suiteDir, "summarize", "files", "data", "report.txt"), "q3");
    return suiteDir;
  }

  it("loads a directory of test directories, defaulting id and files", () => {
    const suiteDir = makeSuite();
    const inputs = loadInputs(suiteDir);

    const byId = Object.fromEntries(inputs.map((input) => [input.id, input]));
    expect(Object.keys(byId).sort()).toEqual(["capital-france", "summarize"]);
    expect(byId["capital-france"].files).toBeUndefined();
    expect(byId["summarize"].files).toBe(fs.realpathSync(path.join(suiteDir, "summarize", "files")));
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("an explicit id in test.json beats the directory name", () => {
    const suiteDir = makeSuite();
    fs.writeFileSync(path.join(suiteDir, "capital-france", "test.json"),
      JSON.stringify({ id: "france", goal: "g", args: {} }));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id).sort()).toEqual(["france", "summarize"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("a lone inputs.json with a top-level inputs array loads as the file form", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(path.join(suiteDir, "inputs.json"), JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {} }, { id: "b", goal: "g", args: {} }],
    }));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id)).toEqual(["a", "b"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("errors when a directory mixes loose input files with test directories", () => {
    const suiteDir = makeSuite();
    fs.writeFileSync(path.join(suiteDir, "loose-input.json"), JSON.stringify({ id: "x", goal: "g", args: {} }));

    expect(() => loadInputs(suiteDir)).toThrow(/mixes.*loose-input\.json.*capital-france/s);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("errors when a wrapper inputs file sits beside other json files", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(path.join(suiteDir, "inputs.json"), JSON.stringify({ inputs: [{ id: "a", goal: "g", args: {} }] }));
    fs.writeFileSync(path.join(suiteDir, "b.json"), JSON.stringify({ id: "b", goal: "g", args: {} }));

    expect(() => loadInputs(suiteDir)).toThrow(/inputs\.json.*b\.json/s);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("subdirectories without test.json are ignored (fixture dirs can sit beside loose inputs)", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(path.join(suiteDir, "a.json"), JSON.stringify({ id: "a", goal: "g", args: {} }));
    fs.mkdirSync(path.join(suiteDir, "shared-fixtures"));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id)).toEqual(["a"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});
