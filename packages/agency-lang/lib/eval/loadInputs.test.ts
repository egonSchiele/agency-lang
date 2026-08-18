import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nanoid } from "nanoid";

import { loadInputs, loadInputsFromFile, inlineInput } from "./loadInputs.js";
import { makeRepo } from "./testUtils.js";

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
      inputs: [{ goal: "do it", input: { prompt: "x" } }],
    });

    expect(loadInputsFromFile(suitePath, () => "generated-id")).toEqual([
      { id: "generated-id", goal: "do it", input: { prompt: "x" } },
    ]);
  });

  it("allows a missing goal when requireGoal is false and preserves metadata", () => {
    const suitePath = writeJson("no-goal.json", {
      inputs: [{ id: "a", input: { country: "Brazil" }, metadata: { expected: "Brasília" } }],
    });
    const inputs = loadInputsFromFile(suitePath, () => "a", { requireGoal: false });
    expect(inputs[0].goal).toBeUndefined();
    expect(inputs[0].metadata).toEqual({ expected: "Brasília" });
  });

  it("passes a first-class expected output through", () => {
    const suitePath = writeJson("with-expected.json", {
      inputs: [{ id: "india", input: { country: "India" }, expected: "New Delhi" }],
    });
    const inputs = loadInputsFromFile(suitePath, () => "india", { requireGoal: false });
    expect(inputs[0].expected).toBe("New Delhi");
  });

  it("still requires a non-empty goal by default", () => {
    const suitePath = writeJson("needs-goal.json", { inputs: [{ id: "a", input: "t" }] });
    expect(() => loadInputsFromFile(suitePath, () => "a")).toThrow(
      /goal must be a non-empty string/,
    );
  });

  it("validates required goals and input ids", () => {
    expect(() =>
      loadInputsFromFile(writeJson("missing-goal.json", { inputs: [{ input: "t" }] })),
    ).toThrow(/goal/i);
    expect(() =>
      loadInputsFromFile(
        writeJson("bad-id.json", { inputs: [{ id: "bad/id", goal: "x", input: "t" }] }),
      ),
    ).toThrow(/invalid id/i);
    expect(() =>
      loadInputsFromFile(
        writeJson("duplicate-id.json", {
          inputs: [
            { id: "same", goal: "a", input: "t" },
            { id: "same", goal: "b", input: "t" },
          ],
        }),
      ),
    ).toThrow(/duplicate/i);
  });

  it("an input is a string or object, or absent for an agent that takes none", () => {
    const [noInput] = loadInputsFromFile(writeJson("no-task.json", { inputs: [{ goal: "g" }] }));
    expect(noInput.input).toBeUndefined();
    expect("input" in noInput).toBe(false);
    expect(() =>
      loadInputsFromFile(writeJson("empty-task.json", { inputs: [{ goal: "g", input: "" }] })),
    ).toThrow(/must not be empty/);
    expect(() =>
      loadInputsFromFile(writeJson("array-task.json", { inputs: [{ goal: "g", input: [1] }] })),
    ).toThrow(/input must be a string, or a JSON object/);
    const loaded = loadInputsFromFile(
      writeJson("object-task.json", { inputs: [{ goal: "g", input: { rows: [1, 2] } }] }),
    );
    expect(loaded[0].input).toEqual({ rows: [1, 2] });
  });

  it("resolves a graders path relative to the test and requires it to exist", () => {
    fs.mkdirSync(path.join(tmpDir, "suite2"));
    fs.writeFileSync(path.join(tmpDir, "suite2", "check.ts"), "export default [];");
    const [input] = loadInputsFromFile(
      writeJson("suite2/wrap.json", { inputs: [{ id: "g", input: "t", graders: "./check.ts" }] }),
    );
    expect(input.graders).toBe(path.join(tmpDir, "suite2", "check.ts"));
    expect(() =>
      loadInputsFromFile(
        writeJson("suite2/bad.json", {
          inputs: [{ id: "g", input: "t", graders: "./missing.ts" }],
        }),
      ),
    ).toThrow(/graders must name a TypeScript file/);
  });

  it("an input with its own graders does not need a goal", () => {
    fs.mkdirSync(path.join(tmpDir, "suite3"));
    fs.writeFileSync(path.join(tmpDir, "suite3", "check.ts"), "export default [];");
    const [input] = loadInputsFromFile(
      writeJson("suite3/wrap.json", { inputs: [{ id: "g", input: "t", graders: "./check.ts" }] }),
    );
    expect(input.goal).toBeUndefined();
  });

  it("test-directory form auto-discovers graders.ts, and a single test dir loads directly", () => {
    const testDir = path.join(tmpDir, "suite4", "my-test");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "test.json"), JSON.stringify({ input: "t", goal: "g" }));
    fs.writeFileSync(path.join(testDir, "graders.ts"), "export default [];");

    // the whole suite: a directory of test dirs
    const fromSuite = loadInputs(path.join(tmpDir, "suite4"));
    expect(fromSuite[0].id).toBe("my-test");
    expect(fromSuite[0].graders).toBe(path.join(testDir, "graders.ts"));

    // one test: the test dir itself, keeping the same sugar
    const fromTestDir = loadInputs(testDir);
    expect(fromTestDir).toHaveLength(1);
    expect(fromTestDir[0].id).toBe("my-test");
    expect(fromTestDir[0].graders).toBe(path.join(testDir, "graders.ts"));
  });

  it("timeoutSec must be a positive number when provided", () => {
    const [input] = loadInputsFromFile(
      writeJson("timeout.json", { inputs: [{ id: "t", goal: "g", input: "x", timeoutSec: 1200 }] }),
    );
    expect(input.timeoutSec).toBe(1200);
    for (const bad of [0, -5, "10"]) {
      expect(() =>
        loadInputsFromFile(
          writeJson("timeout-bad.json", {
            inputs: [{ id: "t", goal: "g", input: "x", timeoutSec: bad }],
          }),
        ),
      ).toThrow(/timeoutSec must be a positive number/);
    }
  });

  it("rejects legacy args/node with a migration message", () => {
    expect(() =>
      loadInputsFromFile(
        writeJson("legacy-args.json", { inputs: [{ goal: "g", args: { x: 1 } }] }),
      ),
    ).toThrow(/tests describe the input, not the agent/);
    expect(() =>
      loadInputsFromFile(
        writeJson("legacy-node.json", { inputs: [{ goal: "g", input: "t", node: "main" }] }),
      ),
    ).toThrow(/tests describe the input, not the agent/);
  });

  it("rejects a legacy task field with a message naming the rename", () => {
    expect(() =>
      loadInputsFromFile(writeJson("legacy-task.json", { inputs: [{ goal: "g", task: "do it" }] })),
    ).toThrow(/"task" was renamed to "input"/);
  });

  it("rejects rubric-shaped input files", () => {
    expect(() =>
      loadInputsFromFile(writeJson("rubric-only.json", { inputs: [{ rubric: "x" }] })),
    ).toThrow(/goal/i);
    expect(() =>
      loadInputsFromFile(
        writeJson("goal-and-rubric.json", { inputs: [{ goal: "x", rubric: "y" }] }),
      ),
    ).toThrow(/both goal and rubric/i);
  });

  it("allows an empty suite", () => {
    expect(loadInputsFromFile(writeJson("empty.json", { inputs: [] }))).toEqual([]);
  });

  it("loads input files from a directory in lexical order", () => {
    writeJson("suite/b.json", { id: "b", goal: "B", input: "t" });
    writeJson("suite/a.json", { id: "a", goal: "A", input: { n: 1 } });

    const inputs = loadInputs(path.join(tmpDir, "suite"));

    expect(inputs.map((input) => input.id)).toEqual(["a", "b"]);
    expect(inputs[0].input).toEqual({ n: 1 });
  });

  it("rejects a directory with no json files: an empty suite is a mistake, not a run", () => {
    fs.mkdirSync(path.join(tmpDir, "empty"));
    fs.writeFileSync(path.join(tmpDir, "empty", "note.txt"), "ignore me");

    expect(() => loadInputs(path.join(tmpDir, "empty"))).toThrow(/no inputs loaded from/);
  });

  it("creates an inline input with no goal", () => {
    expect(inlineInput("do it")).toEqual({ id: "input-1", input: "do it" });
    expect(() => inlineInput("")).toThrow(/--input/);
  });
});

describe("files field", () => {
  it("resolves files relative to the inputs file and requires a directory", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.mkdirSync(path.join(suiteDir, "fixtures", "report"), { recursive: true });
    fs.writeFileSync(path.join(suiteDir, "fixtures", "report", "q3.txt"), "data");
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [{ id: "a", goal: "g", input: "t", files: "./fixtures/report" }],
      }),
    );

    const [input] = loadInputs(inputsFile);

    expect(input.files).toBe(fs.realpathSync(path.join(suiteDir, "fixtures", "report")));
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("rejects a files value that is not a directory", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.writeFileSync(path.join(suiteDir, "not-a-dir.txt"), "x");
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [{ id: "a", goal: "g", input: "t", files: "./not-a-dir.txt" }],
      }),
    );

    expect(() => loadInputs(inputsFile)).toThrow(/files must name a directory/i);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});

describe("test directories (heavy form)", () => {
  function makeSuite(): string {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.mkdirSync(path.join(suiteDir, "capital-france"));
    fs.writeFileSync(
      path.join(suiteDir, "capital-france", "test.json"),
      JSON.stringify({ goal: "Return the capital of France", input: "t", expected: "Paris" }),
    );
    fs.mkdirSync(path.join(suiteDir, "summarize", "files", "data"), { recursive: true });
    fs.writeFileSync(
      path.join(suiteDir, "summarize", "test.json"),
      JSON.stringify({ goal: "Summarize the report", input: "t" }),
    );
    fs.writeFileSync(path.join(suiteDir, "summarize", "files", "data", "report.txt"), "q3");
    return suiteDir;
  }

  it("loads a directory of test directories, defaulting id and files", () => {
    const suiteDir = makeSuite();
    const inputs = loadInputs(suiteDir);

    const byId = Object.fromEntries(inputs.map((input) => [input.id, input]));
    expect(Object.keys(byId).sort()).toEqual(["capital-france", "summarize"]);
    expect(byId["capital-france"].files).toBeUndefined();
    expect(byId["summarize"].files).toBe(
      fs.realpathSync(path.join(suiteDir, "summarize", "files")),
    );
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("an explicit id in test.json beats the directory name", () => {
    const suiteDir = makeSuite();
    fs.writeFileSync(
      path.join(suiteDir, "capital-france", "test.json"),
      JSON.stringify({ id: "france", goal: "g", input: "t" }),
    );
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id).sort()).toEqual(["france", "summarize"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("a lone inputs.json with a top-level inputs array loads as the file form", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(
      path.join(suiteDir, "inputs.json"),
      JSON.stringify({
        inputs: [
          { id: "a", goal: "g", input: "t" },
          { id: "b", goal: "g", input: "t" },
        ],
      }),
    );
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id)).toEqual(["a", "b"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("errors when a directory mixes loose input files with test directories", () => {
    const suiteDir = makeSuite();
    fs.writeFileSync(
      path.join(suiteDir, "loose-input.json"),
      JSON.stringify({ id: "x", goal: "g", input: "t" }),
    );

    expect(() => loadInputs(suiteDir)).toThrow(/mixes.*loose-input\.json.*capital-france/s);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("errors when a wrapper inputs file sits beside other json files", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(
      path.join(suiteDir, "inputs.json"),
      JSON.stringify({ inputs: [{ id: "a", goal: "g", input: "t" }] }),
    );
    fs.writeFileSync(
      path.join(suiteDir, "b.json"),
      JSON.stringify({ id: "b", goal: "g", input: "t" }),
    );

    expect(() => loadInputs(suiteDir)).toThrow(/inputs\.json.*b\.json/s);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("subdirectories without test.json are ignored (fixture dirs can sit beside loose inputs)", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(
      path.join(suiteDir, "a.json"),
      JSON.stringify({ id: "a", goal: "g", input: "t" }),
    );
    fs.mkdirSync(path.join(suiteDir, "shared-fixtures"));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id)).toEqual(["a"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});

describe("git sources for files", () => {
  it("resolves a files git source and records provenance", () => {
    const { repo, first } = makeRepo();
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    const filesSource = `${repo}//tests?ref=${first}`;
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [{ id: "a", goal: "g", input: "t", files: filesSource }],
      }),
    );

    const provenance: Record<string, { source: string; sha?: string }> = {};
    const [input] = loadInputs(inputsFile, nanoid, {
      filesProvenance: provenance,
      sourceCacheRoot: path.join(suiteDir, "cache"),
    });

    expect(fs.readFileSync(path.join(input.files!, "a.txt"), "utf8")).toBe("v1");
    expect(provenance["a"]).toEqual({ source: filesSource, sha: first });
    fs.rmSync(suiteDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("records provenance even for an input id of __proto__ (null-prototype accumulator)", () => {
    const { repo, first } = makeRepo();
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [{ id: "__proto__", goal: "g", input: "t", files: `${repo}//tests?ref=${first}` }],
      }),
    );

    const provenance: Record<string, { source: string; sha?: string }> = Object.create(null);
    loadInputs(inputsFile, nanoid, {
      filesProvenance: provenance,
      sourceCacheRoot: path.join(suiteDir, "cache"),
    });

    expect(Object.hasOwn(provenance, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(provenance))["__proto__"].sha).toBe(first);
    fs.rmSync(suiteDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("forbids git files sources when the suite itself came from git (one-level rule)", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [{ id: "a", goal: "g", input: "t", files: "git@github.com:x/y.git" }],
      }),
    );

    expect(() => loadInputs(inputsFile, nanoid, { forbidGitFiles: true })).toThrow(
      /one level|vendor/i,
    );
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});
