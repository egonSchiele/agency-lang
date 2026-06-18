import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initializeEvalRun,
  prepareInput,
  recordInputPrepareFailure,
  recordInputRunFailure,
  shouldExtractStatelog,
  writeEvalRunSummary,
} from "./runArtifacts.js";

describe("eval run artifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-artifacts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes a run directory with config", () => {
    const state = initializeEvalRun({
      runId: "r1",
      runsDir: tmpDir,
      agent: "agent.agency:main",
      inputsSource: "tasks.json",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    });

    expect(fs.existsSync(path.join(tmpDir, "r1", "inputs"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "r1", "config.json"), "utf-8"))).toMatchObject({
      runId: "r1",
      agent: "agent.agency:main",
      inputsSource: "tasks.json",
      continueOnError: true,
      startedAt: "2026-06-09T14:30:00.000Z",
    });
    expect(state.runDir).toBe(path.join(tmpDir, "r1"));
  });

  it("rejects existing run directories before writing partial state", () => {
    fs.mkdirSync(path.join(tmpDir, "existing"), { recursive: true });

    expect(() => initializeEvalRun({
      runId: "existing",
      runsDir: tmpDir,
      agent: "agent.agency:main",
      inputsSource: "tasks.json",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    })).toThrow(
      `Run directory already exists: ${path.join(tmpDir, "existing")}.
Choose a different --run-id or delete the existing directory.`,
    );

    expect(fs.existsSync(path.join(tmpDir, "existing", "inputs"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "existing", "config.json"))).toBe(false);
  });

  it("prepares per-input artifact paths and an empty workdir", () => {
    const state = initializeState();

    const prepared = prepareInput(state, { id: "t1", goal: "goal", args: {} });

    expect(JSON.parse(fs.readFileSync(path.join(state.runDir, "inputs", "t1", "input.json"), "utf-8"))).toMatchObject({ id: "t1", goal: "goal" });
    expect(fs.existsSync(prepared.workdirPath)).toBe(true);
    expect(prepared.statelogPath).toBe(path.join(state.runDir, "inputs", "t1", "statelog.jsonl"));
    expect(prepared.evalRecordPath).toBe(path.join(state.runDir, "inputs", "t1", "eval-record.json"));
  });

  it("rejects run ids that escape the runs directory", () => {
    expect(() => initializeEvalRun({
      runId: "../escape",
      runsDir: tmpDir,
      agent: "agent.agency:main",
      inputsSource: "tasks.json",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    })).toThrow("Invalid runId");
  });

  it("rejects input ids that escape the input directory", () => {
    const state = initializeState();

    expect(() => prepareInput(state, { id: "../escape", goal: "goal", args: {} })).toThrow("Invalid id");
  });

  it("copies a fixture working_dir into the input workdir", () => {
    const state = initializeState();
    const fixture = path.join(tmpDir, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "input.txt"), "fixture-data");

    const prepared = prepareInput(state, { id: "t1", goal: "goal", args: {}, working_dir: fixture });

    expect(fs.readFileSync(path.join(prepared.workdirPath, "input.txt"), "utf-8")).toBe("fixture-data");
    expect(fs.readFileSync(path.join(fixture, "input.txt"), "utf-8")).toBe("fixture-data");
  });

  it("rejects working_dir values that point to files", () => {
    const state = initializeState();
    const fixtureFile = path.join(tmpDir, "fixture.txt");
    fs.writeFileSync(fixtureFile, "fixture-data");

    expect(() => prepareInput(state, {
      id: "t1",
      goal: "goal",
      args: {},
      working_dir: fixtureFile,
    })).toThrow("working_dir must be a directory");
  });

  it("records prepare failures without touching artifact paths", () => {
    const result = recordInputPrepareFailure("t1", "invalid id");

    expect(result).toEqual({
      inputId: "t1",
      status: "error",
      evalRecordPath: "",
      statelogPath: "",
      workdirPath: "",
      errorMessage: "invalid id",
    });
  });

  it("records run failures and writes error.txt + summary", () => {
    const state = initializeState();
    const prepared = prepareInput(state, { id: "t1", goal: "goal", args: {} });

    const result = recordInputRunFailure(prepared, "boom");
    const summary = writeEvalRunSummary(state, [result]);

    expect(fs.readFileSync(path.join(state.runDir, "inputs", "t1", "error.txt"), "utf-8")).toBe("boom");
    expect(summary.errorCount).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(state.runDir, "summary.json"), "utf-8"))).toMatchObject({ errorCount: 1 });
  });

  it("extracts only when statelog exists and is non-empty", () => {
    const statelog = path.join(tmpDir, "statelog.jsonl");

    expect(shouldExtractStatelog(statelog)).toBe(false);
    fs.writeFileSync(statelog, "");
    expect(shouldExtractStatelog(statelog)).toBe(false);
    fs.writeFileSync(statelog, "{}\n");
    expect(shouldExtractStatelog(statelog)).toBe(true);
  });

  function initializeState() {
    return initializeEvalRun({
      runId: "r1",
      runsDir: tmpDir,
      agent: "agent.agency:main",
      inputsSource: "tasks.json",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    });
  }
});
