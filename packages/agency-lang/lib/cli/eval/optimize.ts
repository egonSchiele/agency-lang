import * as path from "path";
import { fileURLToPath } from "url";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadTasks } from "@/eval/loadTasks.js";
import { LlmJudge } from "@/optimize/grading/llmJudge.js";
import type { Input, JSON as AgencyJSON } from "@/optimize/grading/types.js";
import type { BaseOptimizerConfig, Optimizer, OptimizeTarget } from "@/optimize/optimizer.js";
import { type OptimizeVerbosity } from "@/optimize/reporter.js";
import { DEFAULT_OPTIMIZER, getOptimizer } from "@/optimize/registry.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "@/optimize/targets.js";
import type { OptimizeResult } from "@/optimize/types.js";
import { parseAgency } from "@/parser.js";

import { resolveEvalRunTarget, validateTaskSelection } from "./run.js";

export type EvalOptimizeOptions = {
  agent: string;
  tasks?: string;
  goal?: string;
  iterations?: number;
  writeback?: boolean;
  silent?: boolean;
  runsDir?: string;
  runId?: string;
  mutatorModel?: string;
  optimizer?: string;
  config?: AgencyConfig;
};

export function resolveVerbosity(opts: { silent?: boolean }): OptimizeVerbosity {
  return opts.silent ? "silent" : "default";
}

export type EvalOptimizeDeps = {
  getOptimizer?: (name: string, config: BaseOptimizerConfig) => Optimizer;
  makeId?: () => string;
  makeRunId?: () => string;
};

const DEFAULT_ITERATIONS = 5;

/** Bundled scalar goal judge: scores how well an output satisfies the input's goal. */
const GOAL_JUDGE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents/goalJudge.agency");

export async function evalOptimize(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps = {},
): Promise<OptimizeResult> {
  const target = buildTarget(opts, deps);
  const config = buildConfig(opts, deps);
  const resolve = deps.getOptimizer ?? getOptimizer;
  const optimizer = resolve(opts.optimizer ?? DEFAULT_OPTIMIZER, config);
  return optimizer.optimize(target);
}

/** Build the optimize target: the agent plus the inputs to run it on (from --goal or --tasks). */
export function buildTarget(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): OptimizeTarget {
  const selection = validateTaskSelection(opts);
  const resolved = resolveEvalRunTarget(opts.agent);
  if (selection === "goal") {
    const targetSet = discoverOptimizeTargets(resolved.agentFile);
    rejectGoalForNodeWithRequiredArgs(targetSet, resolved.node);
    return { agent: opts.agent, inputs: [{ id: "task-1", node: resolved.node, args: {}, metadata: { goal: opts.goal ?? "" } }] };
  }
  const tasks = loadTasks(path.resolve(opts.tasks ?? ""), deps.makeId ?? nanoid);
  const inputs: Input[] = tasks.map((t) => ({
    id: t.task_id,
    node: t.node ?? resolved.node,
    args: t.args as Record<string, AgencyJSON>,
    metadata: { goal: t.goal },
  }));
  return { agent: opts.agent, inputs };
}

/** Build the optimizer config: the goal-judge grader plus run policy/artifacts settings. */
export function buildConfig(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): BaseOptimizerConfig {
  const config = opts.config ?? {};
  return {
    graders: [new LlmJudge({ name: "goal", agencyFile: GOAL_JUDGE_FILE, goalPath: ["metadata", "goal"] })],
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
    config,
    runsDir: path.resolve(opts.runsDir ?? config.eval?.optimizeRunsDir ?? path.join(config.eval?.runsDir ?? "runs", "optimize")),
    runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    writeback: opts.writeback ?? true,
    mutatorModel: opts.mutatorModel,
  };
}

/**
 * `--goal` desugars to a single no-argument input, so it cannot drive a node
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
        `Node ${node} requires arguments, but --goal creates a no-argument input.\n` +
        "Use --tasks tasks.json to provide args for this agent.",
      );
    }
  }
}
