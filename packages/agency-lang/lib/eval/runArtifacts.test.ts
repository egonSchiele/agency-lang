import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initializeEvalRun,
  prepareEvalRunTask,
  recordEvalRunTaskError,
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
      tasksSource: "tasks.json",
      tasks: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    });

    expect(fs.existsSync(path.join(tmpDir, "r1", "tasks"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "r1", "config.json"), "utf-8"))).toMatchObject({
      runId: "r1",
      agent: "agent.agency:main",
      tasksSource: "tasks.json",
      continueOnError: true,
      startedAt: "2026-06-09T14:30:00.000Z",
    });
    expect(state.runDir).toBe(path.join(tmpDir, "r1"));
  });

  it("prepares per-task artifact paths and an empty workdir", () => {
    const state = initializeState();

    const prepared = prepareEvalRunTask(state, { task_id: "t1", rubric: "rubric", args: {} });

    expect(JSON.parse(fs.readFileSync(path.join(state.runDir, "tasks", "t1", "task.json"), "utf-8"))).toMatchObject({ task_id: "t1" });
    expect(fs.existsSync(prepared.workdirPath)).toBe(true);
    expect(prepared.statelogPath).toBe(path.join(state.runDir, "tasks", "t1", "statelog.jsonl"));
    expect(prepared.evalRecordPath).toBe(path.join(state.runDir, "tasks", "t1", "eval-record.json"));
  });

  it("copies a fixture working_dir into the task workdir", () => {
    const state = initializeState();
    const fixture = path.join(tmpDir, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "input.txt"), "fixture-data");

    const prepared = prepareEvalRunTask(state, { task_id: "t1", rubric: "rubric", args: {}, working_dir: fixture });

    expect(fs.readFileSync(path.join(prepared.workdirPath, "input.txt"), "utf-8")).toBe("fixture-data");
    expect(fs.readFileSync(path.join(fixture, "input.txt"), "utf-8")).toBe("fixture-data");
  });

  it("records task errors and writes summary", () => {
    const state = initializeState();
    const prepared = prepareEvalRunTask(state, { task_id: "t1", rubric: "rubric", args: {} });

    const result = recordEvalRunTaskError(prepared, "boom");
    const summary = writeEvalRunSummary(state, [result]);

    expect(fs.readFileSync(path.join(state.runDir, "tasks", "t1", "error.txt"), "utf-8")).toBe("boom");
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
      tasksSource: "tasks.json",
      tasks: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    });
  }
});
