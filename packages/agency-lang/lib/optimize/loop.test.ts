import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { optimizeLoop } from "./loop.js";
import type { OptimizeTaskVerdict } from "./types.js";
import type { EvalRunResult, EvalRunTask } from "@/eval/runTypes.js";

describe("optimizeLoop", () => {
  let tmpDir: string;
  const tasks: EvalRunTask[] = [{ task_id: "t1", rubric: "prefer accuracy", args: { text: "hi" } }];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-loop-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("evaluates baseline, accepts a winning candidate, and writes back when source hash matches", async () => {
    const sourcePath = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(sourcePath, agentSource("old ${text}"));

    const result = await optimizeLoop(baseConfig({ target: { writebackPath: sourcePath } }), {
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: fakeEvalRun(),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("candidate", 80),
    });

    expect(result).toMatchObject({ championIter: 1, acceptedCount: 1, rejectedCount: 0 });
    expect(result.championSource).toContain("new ${text}");
    expect(fs.readFileSync(sourcePath, "utf-8")).toContain("new ${text}");
  });

  it("keeps baseline when the candidate loses", async () => {
    const result = await optimizeLoop(baseConfig({}), {
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: fakeEvalRun(),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("champion", 80),
    });

    expect(result).toMatchObject({ championIter: "baseline", acceptedCount: 0, rejectedCount: 1 });
    expect(result.championSource).toContain("old ${text}");
  });

  it("retries validation once, records validation-failed after a second invalid prompt, and continues", async () => {
    const prompts = ["no interpolation", "still no interpolation", "better ${text}"];
    const result = await optimizeLoop(baseConfig({ policy: { iterations: 2 } }), {
      mutate: async () => ({ prompt: prompts.shift() ?? "better ${text}", rationale: "Try." }),
      evalRun: fakeEvalRun(),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("candidate", 80),
    });

    expect(result.validationFailedCount).toBe(1);
    expect(result.acceptedCount).toBe(1);
    expect(result.iterations.map((iteration) => iteration.decision)).toContain("validation-failed");
  });

  it("records runtime rejections and continues when eval or judge fails", async () => {
    let evalCalls = 0;
    let judgeCalls = 0;
    const result = await optimizeLoop(baseConfig({ policy: { iterations: 3 } }), {
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: async (args) => {
        evalCalls += 1;
        if (evalCalls === 2) throw new Error("eval exploded");
        return fakeEvalRun()(args);
      },
      judgeTask: async () => {
        judgeCalls += 1;
        if (judgeCalls === 1) throw new Error("judge exploded");
        return taskVerdict("candidate", 80);
      },
    });

    expect(result.rejectedCount).toBe(2);
    expect(result.acceptedCount).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "runs", "run", "iter-1", "error.txt"), "utf-8")).toContain("eval exploded");
    expect(fs.readFileSync(path.join(tmpDir, "runs", "run", "iter-2", "error.txt"), "utf-8")).toContain("judge exploded");
  });

  it("rejects a candidate with missing eval records instead of accepting a partial suite", async () => {
    const result = await optimizeLoop(baseConfig({}), {
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: fakeEvalRun({ omitRecordsAfterBaseline: true }),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("candidate", 80),
    });

    expect(result).toMatchObject({ championIter: "baseline", rejectedCount: 1, acceptedCount: 0 });
  });

  it("throws on writeback hash mismatch after writing artifacts", async () => {
    const sourcePath = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(sourcePath, agentSource("old ${text}"));
    const config = baseConfig({ target: { writebackPath: sourcePath } });
    fs.writeFileSync(sourcePath, agentSource("external ${text}"));

    await expect(optimizeLoop(config, {
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: fakeEvalRun(),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("candidate", 80),
    })).rejects.toThrow(/modified externally/i);

    expect(fs.readFileSync(sourcePath, "utf-8")).toContain("external ${text}");
    expect(fs.existsSync(path.join(tmpDir, "runs", "run", "summary.json"))).toBe(true);
  });

  it("rejects optimize config keys that are parsed but not supported yet", async () => {
    await expect(optimizeLoop(baseConfig({
      target: { agentSource: agentSource("old ${text}", "prompt, temperature") },
    }), {
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: fakeEvalRun(),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("candidate", 80),
    })).rejects.toThrow(/Unsupported @optimize keys: temperature/);
  });

  it("reports progress for long-running optimization phases", async () => {
    const messages: string[] = [];

    await optimizeLoop(baseConfig({}), {
      report: (message) => messages.push(message),
      mutate: async () => ({ prompt: "new ${text}", rationale: "Clearer." }),
      evalRun: fakeEvalRun(),
      judgeTask: async (): Promise<OptimizeTaskVerdict> => taskVerdict("candidate", 80),
    });

    expect(messages).toEqual([
      "[optimize] Run run: writing baseline artifacts",
      "[optimize] Evaluating baseline on 1 task(s)",
      "[optimize] Iteration 1/1: proposing prompt mutation",
      "[optimize] Iteration 1/1: evaluating candidate",
      "[optimize] Iteration 1/1: judging candidate against champion",
      "[optimize] Iteration 1/1: accepted (wins 1, losses 0, ties 0)",
      "[optimize] Writing final champion and summary",
      "[optimize] Complete: champion iteration 1, accepted 1, rejected 0, validation failed 0",
    ]);
  });

  function baseConfig(overrides: {
    runtime?: Partial<Parameters<typeof optimizeLoop>[0]["runtime"]>;
    target?: Partial<Parameters<typeof optimizeLoop>[0]["target"]>;
    policy?: Partial<Parameters<typeof optimizeLoop>[0]["policy"]>;
    artifacts?: Partial<Parameters<typeof optimizeLoop>[0]["artifacts"]>;
  }): Parameters<typeof optimizeLoop>[0] {
    const base: Parameters<typeof optimizeLoop>[0] = {
      runtime: { config: {}, tasks },
      target: {
        agentSource: agentSource("old ${text}"),
        node: "main",
        agentFilename: "agent.agency",
        workingDir: tmpDir,
      },
      policy: {
        goal: "improve accuracy",
        iterations: 1,
        judgeSamples: 1,
        acceptThreshold: 0,
      },
      artifacts: { runsDir: path.join(tmpDir, "runs"), runId: "run" },
    };
    return {
      runtime: { ...base.runtime, ...overrides.runtime },
      target: { ...base.target, ...overrides.target },
      policy: { ...base.policy, ...overrides.policy },
      artifacts: { ...base.artifacts, ...overrides.artifacts },
    };
  }
});

function agentSource(prompt: string, optimizeKeys = "prompt"): string {
  return `node main(text: string): string {
  @optimize(${optimizeKeys})
  const result: string = llm("${prompt}")
  return result
}\n`;
}

function taskVerdict(winner: OptimizeTaskVerdict["winner"], confidence: number): OptimizeTaskVerdict {
  return { taskId: "t1", winner, confidence, samples: [{ winner, confidence, reasoning: "because" }] };
}

function fakeEvalRun(opts: { omitRecordsAfterBaseline?: boolean } = {}) {
  let calls = 0;
  return async (args: { runsDir: string; runId: string; tasks: EvalRunTask[]; agent: string }): Promise<EvalRunResult> => {
    calls += 1;
    const runDir = path.join(args.runsDir, args.runId);
    const results = args.tasks.map((task) => {
      const taskDir = path.join(runDir, "tasks", task.task_id);
      fs.mkdirSync(taskDir, { recursive: true });
      const evalRecordPath = path.join(taskDir, "eval-record.json");
      if (!(opts.omitRecordsAfterBaseline && calls > 1)) {
        fs.writeFileSync(evalRecordPath, JSON.stringify({ recordVersion: 2, evalOutputs: [{ value: calls === 1 ? "old" : "new", tMs: 1 }] }));
      }
      return { taskId: task.task_id, status: "success" as const, evalRecordPath, statelogPath: "", workdirPath: "" };
    });
    return { runId: args.runId, runDir, agent: args.agent, tasks: results, okCount: results.length, errorCount: 0 };
  };
}
