import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadTasks } from "@/eval/loadTasks.js";
import { optimizeLoop } from "@/optimize/loop.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";
import { approve } from "@/runtime/interrupts.js";
import { getRuntimeContext, runInBootstrapFrame } from "@/runtime/asyncContext.js";
import { RuntimeContext } from "@/runtime/state/context.js";

import { resolveEvalRunTarget } from "./run.js";

export type EvalOptimizeOptions = {
  agent: string;
  tasks?: string;
  goal: string;
  iterations?: number;
  judgeSamples?: number;
  acceptThreshold?: number;
  runsDir?: string;
  runId?: string;
  mutatorModel?: string;
  config?: AgencyConfig;
};

export type EvalOptimizeDeps = {
  optimizeLoop?: (config: OptimizeLoopConfig) => Promise<OptimizeResult>;
  makeId?: () => string;
  makeRunId?: () => string;
};

const DEFAULT_ITERATIONS = 5;
const DEFAULT_JUDGE_SAMPLES = 3;
const DEFAULT_ACCEPT_THRESHOLD = 0;

export async function evalOptimize(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps = {},
): Promise<OptimizeResult> {
  const config = buildOptimizeLoopConfig(opts, deps);
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: opts.config?.client ?? {},
    dirname: config.workingDir,
  });
  return runInBootstrapFrame(ctx, async () => {
    getRuntimeContext().ctx.pushHandler(async () => approve());
    try {
      if (deps.optimizeLoop) return await deps.optimizeLoop(config);
      return await optimizeLoop(config, { report: (message) => console.error(message) });
    } finally {
      getRuntimeContext().ctx.popHandler();
    }
  }, { moduleDir: config.workingDir });
}

function buildOptimizeLoopConfig(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps,
): OptimizeLoopConfig {
  if (!opts.tasks) throw new Error("Provide --tasks for eval optimize");
  if (!opts.goal) throw new Error("Provide --goal for eval optimize");
  const target = resolveEvalRunTarget(opts.agent);
  const tasks = loadTasks(path.resolve(opts.tasks), deps.makeId ?? nanoid);
  const agentSource = fs.readFileSync(target.agentFile, "utf-8");
  const config = opts.config ?? {};
  return {
    config,
    agentSource,
    node: target.node,
    tasks,
    goal: opts.goal,
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
    judgeSamples: opts.judgeSamples ?? DEFAULT_JUDGE_SAMPLES,
    acceptThreshold: opts.acceptThreshold ?? DEFAULT_ACCEPT_THRESHOLD,
    runsDir: path.resolve(opts.runsDir ?? config.eval?.optimizeRunsDir ?? path.join(config.eval?.runsDir ?? "runs", "optimize")),
    runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    agentFilename: path.basename(target.agentFile),
    workingDir: path.dirname(target.agentFile),
    mutatorModel: opts.mutatorModel,
    writebackPath: target.agentFile,
  };
}
