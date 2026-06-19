import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BaseOptimizerConfig, OptimizeTarget } from "@/optimize/optimizer.js";
import type { OptimizeResult } from "@/optimize/types.js";

import { buildTarget, evalOptimize, type EvalOptimizeOptions } from "./optimize.js";

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

  function writeInputs(inputs: object[]): string {
    const inputsFile = path.join(tmpDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({ inputs }));
    return inputsFile;
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

  it("desugars --goal into a single input-1 input with a first-class goal", async () => {
    const agentFile = writeAgent();
    const { target } = await capture({ agent: agentFile, goal: "Return Paris" });
    expect(target?.inputs).toEqual([{ id: "input-1", node: "main", args: {}, goal: "Return Paris" }]);
  });

  it("builds one input per entry from --inputs, carrying each goal first-class", async () => {
    const agentFile = writeAgent();
    const inputsFile = writeInputs([{ id: "first", goal: "be correct", args: { text: "hi" } }]);
    const { target } = await capture({ agent: `${agentFile}:main`, inputs: inputsFile });
    expect(target?.inputs).toEqual([{ id: "first", goal: "be correct", args: { text: "hi" }, node: "main" }]);
  });

  it("requires at least one of --inputs or --goal", async () => {
    const agentFile = writeAgent();
    await expect(evalOptimize({ agent: agentFile, config: {} })).rejects.toThrow(/Provide --inputs.*or --goal/i);
  });

  it("allows --inputs and --goal together; --goal fills in as the overall-goal default", async () => {
    const agentFile = writeAgent();
    const inputsFile = writeInputs([{ id: "first", args: { text: "hi" } }]);   // no per-input goal
    const { target } = await capture({ agent: `${agentFile}:main`, inputs: inputsFile, goal: "overall goal" });
    expect(target?.inputs).toEqual([{ id: "first", args: { text: "hi" }, node: "main", goal: "overall goal" }]);
  });

  it("loads graders from a configured grading module instead of the default goal judge", async () => {
    const agentFile = writeAgent();
    const inputsFile = writeInputs([{ id: "a", args: {}, metadata: { expected: "x" } }]);   // no goal; grading module present
    // Write the grading module inside the package so its `import "agency-lang/optimize"` resolves.
    const gradingDir = fs.mkdtempSync(path.join(process.cwd(), ".test-grading-"));
    try {
      const gradingFile = path.join(gradingDir, "grading.ts");
      fs.writeFileSync(gradingFile, `import { grader } from "agency-lang/optimize";
export default [grader(({ output }) => (output === "x" ? 1 : 0), { name: "mine" })];`);
      const { config } = await capture({ agent: `${agentFile}:main`, inputs: inputsFile, graders: gradingFile });
      expect(config?.graders.map((g) => g.name())).toEqual(["mine"]);
    } finally {
      fs.rmSync(gradingDir, { recursive: true, force: true });
    }
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

  it("includes the minibatch size in the config for the gepa optimizer", async () => {
    const agentFile = writeAgent();
    const { config } = await capture({ agent: agentFile, goal: "g", optimizer: "gepa", minibatch: 4 });
    expect((config as { minibatch?: number }).minibatch).toBe(4);
  });

  it("defaults the gepa minibatch when not provided", async () => {
    const agentFile = writeAgent();
    const { config } = await capture({ agent: agentFile, goal: "g", optimizer: "gepa" });
    expect((config as { minibatch?: number }).minibatch).toBe(8);
  });

  it("omits minibatch from the config for non-gepa optimizers", async () => {
    const agentFile = writeAgent();
    const { config } = await capture({ agent: agentFile, goal: "g", minibatch: 4 });
    expect((config as { minibatch?: number }).minibatch).toBeUndefined();
  });

  it("loads validation inputs from a file into the target", () => {
    const agentFile = writeAgent();
    const trainFile = path.join(tmpDir, "train.json");
    const valFile = path.join(tmpDir, "val.json");
    fs.writeFileSync(trainFile, JSON.stringify({ inputs: [{ id: "t", goal: "g", args: {} }] }));
    fs.writeFileSync(valFile, JSON.stringify({ inputs: [{ id: "v", goal: "g", args: {} }] }));
    const target = buildTarget({ agent: `${agentFile}:main`, inputs: trainFile, validationInputs: valFile }, {});
    expect(target.validationInputs?.map((i) => i.id)).toEqual(["v"]);
    expect(target.inputs.map((i) => i.id)).toEqual(["t"]);
  });

  it("splits train inputs by ratio when --validation-split is given", () => {
    const agentFile = writeAgent();
    const trainFile = path.join(tmpDir, "train.json");
    const inputs = Array.from({ length: 10 }, (_u, i) => ({ id: `t${i}`, goal: "g", args: {} }));
    fs.writeFileSync(trainFile, JSON.stringify({ inputs }));
    const target = buildTarget({ agent: `${agentFile}:main`, inputs: trainFile, validationSplit: 0.3, seed: 1 }, {});
    expect(target.validationInputs).toHaveLength(3);
    expect(target.inputs).toHaveLength(7);
  });
});
