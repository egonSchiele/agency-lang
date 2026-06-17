import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRuntimeContext } from "@/runtime/asyncContext.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";

import { evalOptimize, resolveVerbosity, type EvalOptimizeOptions } from "./optimize.js";

describe("eval optimize CLI", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-optimize-cli-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(relativePath = "agent.agency", source = "optimize const prompt = \"hi\"\n\nnode main() {}\n"): string {
    const file = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  }

  function writeTasks(tasks: object[]): string {
    const tasksFile = path.join(tmpDir, "tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({ tasks }));
    return tasksFile;
  }

  async function captureConfig(opts: Partial<EvalOptimizeOptions> & { agent: string }): Promise<OptimizeLoopConfig> {
    const capture: { loopConfig?: OptimizeLoopConfig } = {};
    await evalOptimize(
      { config: {}, ...opts },
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
    return capture.loopConfig;
  }

  it("builds the loop config from a task suite with discovered targets", async () => {
    const agentFile = writeAgent();
    const tasksFile = writeTasks([{ task_id: "first", goal: "be correct", args: { text: "hi" } }]);

    const config = await captureConfig({
      agent: `${agentFile}:main`,
      tasks: tasksFile,
      iterations: 3,
      runsDir: path.join(tmpDir, "runs"),
      runId: "run",
    });

    expect(config.runtime.tasks).toEqual([{ task_id: "first", goal: "be correct", args: { text: "hi" } }]);
    expect(config.runtime.tasksSource).toBe(tasksFile);
    expect(config.target.node).toBe("main");
    expect(config.target.entryFile).toBe("agent.agency");
    expect(config.target.targetSet.targets.map((target) => target.id)).toEqual([
      "agent.agency:global:prompt",
    ]);
    expect(config.target.writeback).toBe(true);
    expect(config.policy).toEqual({ iterations: 3, mutatorModel: undefined });
    expect(config.artifacts).toEqual({ runsDir: path.join(tmpDir, "runs"), runId: "run" });
  });

  it("desugars --goal into a single task-1 task", async () => {
    const agentFile = writeAgent();

    const config = await captureConfig({ agent: agentFile, goal: "Return Paris" });

    expect(config.runtime.tasks).toEqual([{ task_id: "task-1", goal: "Return Paris", args: {} }]);
    expect(config.runtime.tasksSource).toBe("inline:--goal");
  });

  it("requires exactly one of --tasks or --goal", async () => {
    const agentFile = writeAgent();
    const tasksFile = writeTasks([{ task_id: "first", goal: "g", args: {} }]);

    await expect(evalOptimize({ agent: agentFile, config: {} })).rejects.toThrow(/exactly one of --tasks or --goal/i);
    await expect(
      evalOptimize({ agent: agentFile, tasks: tasksFile, goal: "both", config: {} }),
    ).rejects.toThrow(/exactly one of --tasks or --goal/i);
  });

  it("passes judge flags through to the judge policy with eval-judge defaults", async () => {
    const agentFile = writeAgent();

    const defaulted = await captureConfig({ agent: agentFile, goal: "g" });
    expect(defaulted.judgePolicy).toEqual({
      samples: 3,
      confidenceThreshold: 50,
      marginThreshold: 0,
      positionBias: "swap",
    });

    const custom = await captureConfig({
      agent: agentFile,
      goal: "g",
      samples: 5,
      confidenceThreshold: 80,
      marginThreshold: 2,
    });
    expect(custom.judgePolicy).toEqual({
      samples: 5,
      confidenceThreshold: 80,
      marginThreshold: 2,
      positionBias: "swap",
    });
  });

  it("consumes Commander's writeback negation", async () => {
    const agentFile = writeAgent();

    const config = await captureConfig({ agent: agentFile, goal: "g", writeback: false });

    expect(config.target.writeback).toBe(false);
  });

  it("rejects --goal when the selected node requires arguments", async () => {
    const agentFile = writeAgent(
      "agent.agency",
      "optimize const prompt = \"hi\"\n\nnode main(text: string) {}\n",
    );

    await expect(evalOptimize({ agent: `${agentFile}:main`, goal: "g", config: {} }))
      .rejects.toThrow(/requires arguments, but --goal creates a no-argument task/);
  });

  it("allows --goal when node parameters all have defaults", async () => {
    const agentFile = writeAgent(
      "agent.agency",
      "optimize const prompt = \"hi\"\n\nnode main(text: string = \"x\") {}\n",
    );

    const config = await captureConfig({ agent: `${agentFile}:main`, goal: "g" });

    expect(config.runtime.tasks).toHaveLength(1);
  });

  it("discovers the import closure and keys files off the discovery base dir", async () => {
    fs.mkdirSync(path.join(tmpDir, "tools"), { recursive: true });
    writeAgent("app/agent.agency", `
import { helper } from "../shared/prompts.agency"
node main() {}
`);
    writeAgent("shared/prompts.agency", "optimize const prompt = \"shared\"\n\ndef helper() {\n  return prompt\n}\n");
    process.chdir(path.join(tmpDir, "tools"));

    const config = await captureConfig({ agent: "../app/agent.agency:main", goal: "g" });

    const realTmpDir = fs.realpathSync(tmpDir);
    expect(config.target.targetSet.baseDir).toBe(realTmpDir);
    expect(config.target.workingDir).toBe(realTmpDir);
    expect(config.target.entryFile).toBe("app/agent.agency");
    expect(Object.keys(config.target.targetSet.files).sort()).toEqual([
      "app/agent.agency",
      "shared/prompts.agency",
    ]);
  });

  it("installs a CLI-only auto-approve handler around the loop", async () => {
    const agentFile = writeAgent();
    let handlerCountDuringLoop = 0;

    await evalOptimize(
      { agent: agentFile, goal: "g", config: {} },
      {
        optimizeLoop: async (config) => {
          handlerCountDuringLoop = getRuntimeContext().ctx.handlers.length;
          return optimizeResult(config);
        },
      },
    );

    expect(handlerCountDuringLoop).toBe(1);
  });

  it("maps --silent to a verbosity", () => {
    expect(resolveVerbosity({})).toBe("default");
    expect(resolveVerbosity({ silent: true })).toBe("silent");
  });

  it("uses configured optimize runs dir defaults", async () => {
    const agentFile = writeAgent();

    const config = await captureConfig({
      agent: agentFile,
      goal: "g",
      config: { eval: { optimizeRunsDir: path.join(tmpDir, "configured-runs") } },
    });

    expect(config.artifacts).toEqual({
      runsDir: path.join(tmpDir, "configured-runs"),
      runId: "run-id",
    });
    expect(config.policy.iterations).toBe(5);
  });

  it("resolves and runs the optimizer named by --optimizer", async () => {
    const agentFile = writeAgent();
    const sentinel = { runId: "sentinel" } as OptimizeResult;
    const optimizeSpy = vi.fn(async () => sentinel);
    let requestedName: string | undefined;

    const result = await evalOptimize(
      { agent: agentFile, goal: "g", optimizer: "fake", silent: true, config: {} },
      {
        getOptimizer: (name) => {
          requestedName = name;
          return { name, optimize: optimizeSpy };
        },
      },
    );

    expect(requestedName).toBe("fake");
    expect(optimizeSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(sentinel);
  });

  it("defaults to the greedy optimizer when --optimizer is omitted", async () => {
    const agentFile = writeAgent();
    let requestedName: string | undefined;

    await evalOptimize(
      { agent: agentFile, goal: "g", silent: true, config: {} },
      {
        getOptimizer: (name) => {
          requestedName = name;
          return { name, optimize: async () => ({}) as OptimizeResult };
        },
      },
    );

    expect(requestedName).toBe("greedy");
  });
});

function optimizeResult(config: OptimizeLoopConfig): OptimizeResult {
  return {
    runId: config.artifacts.runId,
    runDir: path.join(config.artifacts.runsDir, config.artifacts.runId),
    championIter: "baseline",
    championFiles: {},
    acceptedCount: 0,
    rejectedCount: 0,
    validationFailedCount: 0,
    iterations: [],
  };
}
