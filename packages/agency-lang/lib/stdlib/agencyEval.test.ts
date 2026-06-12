import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _finalizeEvalTask,
  _finishEvalRun,
  _formatEvalRunFailure,
  _initEvalRun,
  _evalJudgeSuite,
  _optimize,
  _prepareEvalTask,
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
      [{ task_id: "../escape", goal: "g", args: {} }],
      "main",
      tmpDir,
      "",
      true,
    );
    expect(state.runId).not.toBe("");

    const prep = _prepareEvalTask(state, state.tasks[0]);
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
      [{ task_id: "t1", goal: "g", args: {} }],
      "main",
      tmpDir,
      "r1",
      true,
    );
    const prep = _prepareEvalTask(state, state.tasks[0]);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // No statelog file written → finalize skips extraction and succeeds.
    const success = await _finalizeEvalTask(prep.prepared, "");
    const error = await _finalizeEvalTask(prep.prepared, "boom");

    expect(success).toMatchObject({ taskId: "t1", status: "success" });
    expect(error).toMatchObject({ taskId: "t1", status: "error", errorMessage: "boom" });
  });

  it("formats failure-like values", () => {
    expect(_formatEvalRunFailure({ value: { message: "limit" } })).toBe("limit");
    expect(_formatEvalRunFailure({ error: { message: "boom" } })).toBe("boom");
    expect(_formatEvalRunFailure("plain")).toBe("plain");
  });

  it("delegates suite judging to the core judgeSuite helper", async () => {
    const result = await _evalJudgeSuite(
      "run-a",
      "run-b",
      [{ task_id: "task-1", goal: "g", args: {} }],
      5,
      60,
      1,
      "none",
      async (args) => ({
        verdictVersion: 2,
        generatedAt: "2026-06-11T00:00:00.000Z",
        policy: args.policy,
        winsA: 0,
        winsB: 1,
        ties: 0,
        winner: "B",
        perTask: [],
      }),
    );

    expect(result).toMatchObject({
      winner: "B",
      policy: { samples: 5, confidenceThreshold: 60, marginThreshold: 1, positionBias: "none" },
    });
  });

  it("delegates optimize requests to the core loop without installing handlers", async () => {
    let loopConfig: OptimizeLoopConfig | null = null;
    const entryFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(entryFile, "optimize const prompt = \"hi\"\nnode main() {}\n");

    const result = await _optimize(
      {},
      entryFile,
      tmpDir,
      "main",
      [{ task_id: "t1", goal: "g", args: {} }],
      "improve",
      2,
      3,
      1,
      tmpDir,
      "run",
      "mutator",
      async (config) => {
        loopConfig = config;
        return optimizeResult(config);
      },
    );

    expect(loopConfig).toMatchObject({
      target: {
        node: "main",
        agentFilename: "agent.agency",
        workingDir: tmpDir,
        agentSource: "optimize const prompt = \"hi\"\nnode main() {}\n",
      },
      policy: {
        goal: "improve",
        iterations: 2,
        judgeSamples: 3,
        acceptThreshold: 1,
        mutatorModel: "mutator",
      },
      artifacts: {
        runsDir: tmpDir,
        runId: "run",
      },
    });
    expect(result).toMatchObject({ runId: "run", championIter: "baseline" });
  });
});

function optimizeResult(config: OptimizeLoopConfig): OptimizeResult {
  return {
    runId: config.artifacts.runId,
    runDir: path.join(config.artifacts.runsDir, config.artifacts.runId),
    championIter: "baseline",
    championSource: config.target.agentSource,
    acceptedCount: 0,
    rejectedCount: 0,
    validationFailedCount: 0,
    iterations: [],
  };
}
