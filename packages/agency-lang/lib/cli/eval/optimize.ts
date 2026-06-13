import * as path from "path";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadTasks, taskFromGoal } from "@/eval/loadTasks.js";
import { optimizeLoop } from "@/optimize/loop.js";
import { createOptimizeReporter, type OptimizeVerbosity } from "@/optimize/reporter.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "@/optimize/targets.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";
import { parseAgency } from "@/parser.js";
import { approve } from "@/runtime/interrupts.js";
import { getRuntimeContext, runInBootstrapFrame } from "@/runtime/asyncContext.js";
import { RuntimeContext } from "@/runtime/state/context.js";

import { resolveEvalRunTarget, validateTaskSelection } from "./run.js";

export type EvalOptimizeOptions = {
  agent: string;
  tasks?: string;
  goal?: string;
  iterations?: number;
  samples?: number;
  confidenceThreshold?: number;
  marginThreshold?: number;
  writeback?: boolean;
  silent?: boolean;
  runsDir?: string;
  runId?: string;
  mutatorModel?: string;
  config?: AgencyConfig;
};

export function resolveVerbosity(opts: { silent?: boolean }): OptimizeVerbosity {
  return opts.silent ? "silent" : "default";
}

export type EvalOptimizeDeps = {
  optimizeLoop?: (config: OptimizeLoopConfig) => Promise<OptimizeResult>;
  makeId?: () => string;
  makeRunId?: () => string;
};

const DEFAULT_ITERATIONS = 5;
const DEFAULT_JUDGE_SAMPLES = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 50;
const DEFAULT_MARGIN_THRESHOLD = 0;

export async function evalOptimize(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps = {},
): Promise<OptimizeResult> {
  const verbosity = resolveVerbosity(opts);
  const config = buildOptimizeLoopConfig(opts, deps);
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: opts.config?.client ?? {},
    dirname: config.target.workingDir,
  });
  return runInBootstrapFrame(ctx, async () => {
    getRuntimeContext().ctx.pushHandler(async () => approve());
    try {
      if (deps.optimizeLoop) return await deps.optimizeLoop(config);
      return await optimizeLoop(config, { reporter: createOptimizeReporter(verbosity) });
    } finally {
      getRuntimeContext().ctx.popHandler();
    }
  }, { moduleDir: config.target.workingDir });
}

function buildOptimizeLoopConfig(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps,
): OptimizeLoopConfig {
  const taskSelection = validateTaskSelection(opts);
  const target = resolveEvalRunTarget(opts.agent);
  const tasks = taskSelection === "goal"
    ? [taskFromGoal(opts.goal ?? "")]
    : loadTasks(path.resolve(opts.tasks ?? ""), deps.makeId ?? nanoid);
  const tasksSource = taskSelection === "goal"
    ? "inline:--goal"
    : path.resolve(opts.tasks ?? "");

  const targetSet = discoverOptimizeTargets(target.agentFile);
  if (taskSelection === "goal") {
    rejectGoalForNodeWithRequiredArgs(targetSet, target.node);
  }

  const config = opts.config ?? {};
  return {
    runtime: { config, tasks, tasksSource },
    target: {
      entryFile: targetSet.entryFile,
      node: target.node,
      targetSet,
      workingDir: targetSet.baseDir,
      writeback: opts.writeback ?? true,
    },
    policy: {
      iterations: opts.iterations ?? DEFAULT_ITERATIONS,
      mutatorModel: opts.mutatorModel,
    },
    judgePolicy: {
      samples: opts.samples ?? DEFAULT_JUDGE_SAMPLES,
      confidenceThreshold: opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      marginThreshold: opts.marginThreshold ?? DEFAULT_MARGIN_THRESHOLD,
      positionBias: "swap",
    },
    artifacts: {
      runsDir: path.resolve(opts.runsDir ?? config.eval?.optimizeRunsDir ?? path.join(config.eval?.runsDir ?? "runs", "optimize")),
      runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    },
  };
}

/**
 * `--goal` desugars to a single no-argument task, so it cannot drive a node
 * that requires arguments. Task files can provide args; goals cannot.
 */
function rejectGoalForNodeWithRequiredArgs(targetSet: OptimizeTargetSet, node: string): void {
  const entry = targetSet.files[targetSet.entryFile];
  const parsed = parseAgency(entry.source, {}, false);
  if (!parsed.success) return;
  for (const candidate of parsed.result.nodes) {
    if (candidate.type !== "graphNode" || candidate.nodeName !== node) continue;
    const required = candidate.parameters.filter((parameter) => parameter.defaultValue === undefined);
    if (required.length > 0) {
      throw new Error(
        `Node ${node} requires arguments, but --goal creates a no-argument task.\n` +
        "Use --tasks tasks.json to provide args for this agent.",
      );
    }
  }
}
