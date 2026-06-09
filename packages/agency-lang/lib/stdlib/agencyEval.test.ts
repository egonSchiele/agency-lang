import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _completeEvalRunTask,
  _finishEvalRun,
  _formatEvalRunFailure,
  _initializeEvalRun,
  _prepareEvalRunTask,
  _recordEvalRunTaskError,
} from "./agencyEval.js";

describe("agency eval stdlib helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-stdlib-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes runs with generated ids and records task errors", () => {
    const state = _initializeEvalRun({ moduleId: "agent" }, [{ task_id: "t1", rubric: "r", args: {} }], "main", tmpDir, "", true);
    expect(state.runId).not.toBe("");

    const prepared = _prepareEvalRunTask(state, state.tasks[0]);
    const result = _recordEvalRunTaskError(state, prepared, "boom");
    const summary = _finishEvalRun(state);

    expect(result.status).toBe("error");
    expect(summary.errorCount).toBe(1);
    expect(fs.existsSync(path.join(state.runDir, "summary.json"))).toBe(true);
  });

  it("completes prepared tasks with success or error results", async () => {
    const state = _initializeEvalRun({ moduleId: "agent" }, [{ task_id: "t1", rubric: "r", args: {} }], "main", tmpDir, "r1", true);
    const prepared = _prepareEvalRunTask(state, state.tasks[0]);

    const success = await _completeEvalRunTask(state, prepared, "");
    const error = await _completeEvalRunTask(state, prepared, "boom");

    expect(success).toMatchObject({ taskId: "t1", status: "success" });
    expect(error).toMatchObject({ taskId: "t1", status: "error", errorMessage: "boom" });
    expect(state.results.map((result) => result.status)).toEqual(["success", "error"]);
  });

  it("formats failure-like values", () => {
    expect(_formatEvalRunFailure({ value: { message: "limit" } })).toBe("limit");
    expect(_formatEvalRunFailure({ error: { message: "boom" } })).toBe("boom");
    expect(_formatEvalRunFailure("plain")).toBe("plain");
  });
});
