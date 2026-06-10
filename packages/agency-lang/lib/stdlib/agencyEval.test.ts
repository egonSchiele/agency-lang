import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _finalizeEvalRunTask,
  _finishEvalRun,
  _formatEvalRunFailure,
  _initEvalRun,
  _optimize,
  _prepareEvalRunTask,
} from "./agencyEval.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";

describe("agency eval stdlib helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-stdlib-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes runs with generated ids and reports prepare failures", () => {
    const state = _initEvalRun(
      { moduleId: "agent" },
      [{ task_id: "../escape", rubric: "r", args: {} }],
      "main",
      tmpDir,
      "",
      true,
    );
    expect(state.runId).not.toBe("");

    const prep = _prepareEvalRunTask(state, state.tasks[0]);
    expect(prep.ok).toBe(false);
    if (!prep.ok) {
      expect(prep.result).toMatchObject({
        taskId: "../escape",
        status: "error",
      });
    }

    const summary = _finishEvalRun(state, prep.ok ? [] : [prep.result]);
    expect(summary.errorCount).toBe(1);
    expect(fs.existsSync(path.join(state.runDir, "summary.json"))).toBe(true);
  });

  it("finalizes prepared tasks with success or error results", async () => {
    const state = _initEvalRun(
      { moduleId: "agent" },
      [{ task_id: "t1", rubric: "r", args: {} }],
      "main",
      tmpDir,
      "r1",
      true,
    );
    const prep = _prepareEvalRunTask(state, state.tasks[0]);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // No statelog file written → finalize skips extraction and succeeds.
    const success = await _finalizeEvalRunTask(prep.prepared, "");
    const error = await _finalizeEvalRunTask(prep.prepared, "boom");

    expect(success).toMatchObject({ taskId: "t1", status: "success" });
    expect(error).toMatchObject({ taskId: "t1", status: "error", errorMessage: "boom" });
  });

  it("formats failure-like values", () => {
    expect(_formatEvalRunFailure({ value: { message: "limit" } })).toBe("limit");
    expect(_formatEvalRunFailure({ error: { message: "boom" } })).toBe("boom");
    expect(_formatEvalRunFailure("plain")).toBe("plain");
  });

  it("delegates optimize requests to the core loop without installing handlers", async () => {
    let loopConfig: OptimizeLoopConfig | null = null;

    const result = await _optimize(
      {},
      "node main() {}\n",
      "main",
      [{ task_id: "t1", rubric: "r", args: {} }],
      "improve",
      2,
      3,
      1,
      tmpDir,
      "run",
      "agent.agency",
      tmpDir,
      "mutator",
      async (config) => {
        loopConfig = config;
        return optimizeResult(config);
      },
    );

    expect(loopConfig).toMatchObject({
      node: "main",
      goal: "improve",
      iterations: 2,
      judgeSamples: 3,
      acceptThreshold: 1,
      runsDir: tmpDir,
      runId: "run",
      agentFilename: "agent.agency",
      workingDir: tmpDir,
      mutatorModel: "mutator",
    });
    expect(result).toMatchObject({ runId: "run", championIter: "baseline" });
  });
});

function optimizeResult(config: OptimizeLoopConfig): OptimizeResult {
  return {
    runId: config.runId,
    runDir: path.join(config.runsDir, config.runId),
    championIter: "baseline",
    championSource: config.agentSource,
    acceptedCount: 0,
    rejectedCount: 0,
    validationFailedCount: 0,
    iterations: [],
  };
}
