import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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

  it("formats failure-like values", () => {
    expect(_formatEvalRunFailure({ value: { message: "limit" } })).toBe("limit");
    expect(_formatEvalRunFailure({ error: { message: "boom" } })).toBe("boom");
    expect(_formatEvalRunFailure("plain")).toBe("plain");
  });
});
