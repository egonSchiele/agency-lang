import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BaseOptimizerConfig, OptimizeTarget } from "@/optimize/optimizer.js";
import type { OptimizeResult } from "@/optimize/types.js";

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

  type Captured = { name?: string; config?: BaseOptimizerConfig; target?: OptimizeTarget };

  /** Run evalOptimize with a fake optimizer that captures the target + config it was built with. */
  async function capture(opts: Partial<EvalOptimizeOptions> & { agent: string }): Promise<Captured> {
    const captured: Captured = {};
    await evalOptimize(
      { config: {}, ...opts },
      {
        makeId: () => "task-id",
        makeRunId: () => "run-id",
        getOptimizer: (name, config) => {
          captured.name = name;
          captured.config = config;
          return {
            name,
            optimize: async (target) => {
              captured.target = target;
              return {} as OptimizeResult;
            },
          };
        },
      },
    );
    return captured;
  }

  it("desugars --goal into a single task-1 input with the goal in metadata", async () => {
    const agentFile = writeAgent();
    const { target } = await capture({ agent: agentFile, goal: "Return Paris" });
    expect(target?.inputs).toEqual([{ id: "task-1", node: "main", args: {}, metadata: { goal: "Return Paris" } }]);
  });

  it("builds one input per task from --tasks, carrying each goal in metadata", async () => {
    const agentFile = writeAgent();
    const tasksFile = writeTasks([{ task_id: "first", goal: "be correct", args: { text: "hi" } }]);
    const { target } = await capture({ agent: `${agentFile}:main`, tasks: tasksFile });
    expect(target?.inputs).toEqual([{ id: "first", node: "main", args: { text: "hi" }, metadata: { goal: "be correct" } }]);
  });

  it("requires exactly one of --tasks or --goal", async () => {
    const agentFile = writeAgent();
    const tasksFile = writeTasks([{ task_id: "first", goal: "g", args: {} }]);
    await expect(evalOptimize({ agent: agentFile, config: {} })).rejects.toThrow(/exactly one of --tasks or --goal/i);
    await expect(evalOptimize({ agent: agentFile, tasks: tasksFile, goal: "both", config: {} })).rejects.toThrow(/exactly one of --tasks or --goal/i);
  });

  it("rejects --goal when the selected node requires arguments", async () => {
    const agentFile = writeAgent("agent.agency", "optimize const prompt = \"hi\"\n\nnode main(text: string) {}\n");
    await expect(evalOptimize({ agent: `${agentFile}:main`, goal: "g", config: {} }))
      .rejects.toThrow(/requires arguments, but --goal creates a no-argument input/);
  });

  it("allows --goal when node parameters all have defaults", async () => {
    const agentFile = writeAgent("agent.agency", "optimize const prompt = \"hi\"\n\nnode main(text: string = \"x\") {}\n");
    const { target } = await capture({ agent: `${agentFile}:main`, goal: "g" });
    expect(target?.inputs).toHaveLength(1);
  });

  it("configures a single goal LlmJudge grader plus run policy", async () => {
    const agentFile = writeAgent();
    const { config } = await capture({ agent: agentFile, goal: "g" });
    expect(config?.graders.map((g) => g.name())).toEqual(["goal"]);
    expect(config?.iterations).toBe(5);
    expect(config?.writeback).toBe(true);
    expect(config?.runId).toBe("run-id");
  });

  it("consumes Commander's writeback negation", async () => {
    const agentFile = writeAgent();
    const { config } = await capture({ agent: agentFile, goal: "g", writeback: false });
    expect(config?.writeback).toBe(false);
  });

  it("resolves and runs the optimizer named by --optimizer", async () => {
    const agentFile = writeAgent();
    const { name } = await capture({ agent: agentFile, goal: "g", optimizer: "fake" });
    expect(name).toBe("fake");
  });

  it("defaults to the greedy optimizer when --optimizer is omitted", async () => {
    const agentFile = writeAgent();
    const { name } = await capture({ agent: agentFile, goal: "g" });
    expect(name).toBe("greedy");
  });

  it("uses configured optimize runs dir defaults", async () => {
    const agentFile = writeAgent();
    const { config } = await capture({ agent: agentFile, goal: "g", config: { eval: { optimizeRunsDir: path.join(tmpDir, "configured-runs") } } });
    expect(config?.runsDir).toBe(path.join(tmpDir, "configured-runs"));
  });

  it("maps --silent to a verbosity", () => {
    expect(resolveVerbosity({})).toBe("default");
    expect(resolveVerbosity({ silent: true })).toBe("silent");
  });
});
