import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRuntimeContext } from "@/runtime/asyncContext.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";

import { evalOptimize } from "./optimize.js";

describe("eval optimize CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-optimize-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads the target source and tasks, installs a CLI-only auto-approve handler, and calls the optimize loop", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const tasksFile = path.join(tmpDir, "tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({
      tasks: [{ task_id: "first", rubric: "be correct", args: { text: "hi" } }],
    }));

    const capture: { loopConfig?: OptimizeLoopConfig } = {};
    let handlerCountDuringLoop = 0;
    const result = await evalOptimize(
      {
        agent: `${agentFile}:main`,
        tasks: tasksFile,
        goal: "improve correctness",
        iterations: 3,
        judgeSamples: 2,
        acceptThreshold: 1,
        runsDir: path.join(tmpDir, "runs"),
        runId: "run",
        config: {},
      },
      {
        optimizeLoop: async (config) => {
          capture.loopConfig = config;
          handlerCountDuringLoop = getRuntimeContext().ctx.handlers.length;
          return optimizeResult(config);
        },
      },
    );

    expect(capture.loopConfig).toMatchObject({
      target: {
        agentSource: "node main() {}\n",
        node: "main",
        agentFilename: "agent.agency",
        workingDir: tmpDir,
        writebackPath: agentFile,
      },
      policy: {
        goal: "improve correctness",
        iterations: 3,
        judgeSamples: 2,
        acceptThreshold: 1,
      },
      artifacts: {
        runId: "run",
      },
    });
    if (!capture.loopConfig) throw new Error("optimize loop was not called");
    expect(capture.loopConfig.runtime.tasks).toEqual([{ task_id: "first", rubric: "be correct", args: { text: "hi" } }]);
    expect(handlerCountDuringLoop).toBe(1);
    expect(result).toMatchObject({ runId: "run", championIter: "baseline" });
  });

  it("uses configured optimize runs dir defaults", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const tasksFile = path.join(tmpDir, "tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({
      tasks: [{ task_id: "task-id", rubric: "inline rubric", args: {} }],
    }));
    const capture: { loopConfig?: OptimizeLoopConfig } = {};

    await evalOptimize(
      {
        agent: agentFile,
        tasks: tasksFile,
        goal: "inline rubric",
        config: { eval: { optimizeRunsDir: path.join(tmpDir, "configured-runs") } },
      },
      {
        makeId: () => "task-id",
        makeRunId: () => "run-id",
        optimizeLoop: async (config) => {
          capture.loopConfig = config;
          return optimizeResult(config);
        },
      },
    );

    if (!capture.loopConfig) throw new Error("optimize loop was not called");
    expect(capture.loopConfig.runtime.tasks).toEqual([{ task_id: "task-id", rubric: "inline rubric", args: {} }]);
    expect(capture.loopConfig).toMatchObject({
      artifacts: {
        runsDir: path.join(tmpDir, "configured-runs"),
        runId: "run-id",
      },
      policy: {
        iterations: 5,
        judgeSamples: 3,
        acceptThreshold: 0,
      },
    });
  });

  it("requires both an optimization goal and a task suite", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");

    await expect(evalOptimize({ agent: agentFile, goal: "improve", config: {} })).rejects.toThrow(/--tasks/i);
    await expect(evalOptimize({ agent: agentFile, tasks: "tasks.json", goal: "", config: {} })).rejects.toThrow(/--goal/i);
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
