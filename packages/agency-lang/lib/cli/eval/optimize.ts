import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadInputs } from "@/eval/loadInputs.js";
import { getAgentsDir } from "@/importPaths.js";
import { LlmJudge } from "@/optimize/grading/graders/llmJudge.js";
import type { Input } from "@/optimize/grading/types.js";
import type { BaseOptimizerConfig, Optimizer, OptimizeTarget } from "@/optimize/optimizer.js";
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
  minibatch?: number;
  seed?: number;
  config?: AgencyConfig;
};

export type EvalOptimizeDeps = {
  getOptimizer?: (name: string, config: BaseOptimizerConfig) => Optimizer;
  makeId?: () => string;
  makeRunId?: () => string;
};

const DEFAULT_ITERATIONS = 5;
const DEFAULT_MINIBATCH = 8;

/** Bundled scalar goal judge: scores how well an output satisfies the input's goal. */
const GOAL_JUDGE_FILE = path.join(getAgentsDir(), "eval", "goalJudge.agency");

export async function evalOptimize(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps = {},
): Promise<OptimizeResult> {
  const target = buildTarget(opts, deps);
  const config = buildConfig(opts, deps);
  const resolve = deps.getOptimizer ?? getOptimizer;
  const optimizer = resolve(opts.optimizer ?? DEFAULT_OPTIMIZER, config);
  const result = await optimizer.optimize(target);
  // Persist the run summary so the path printed by the CLI actually exists.
  if (result.runDir) {
    fs.mkdirSync(result.runDir, { recursive: true });
    fs.writeFileSync(path.join(result.runDir, "summary.json"), JSON.stringify(result, null, 2));
  }
  return result;
}

/** Build the optimize target: the agent plus the inputs to run it on (from --goal or --tasks). */
export function buildTarget(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): OptimizeTarget {
  const selection = validateTaskSelection(opts);
  const resolved = resolveEvalRunTarget(opts.agent);
  if (selection === "goal") {
    const targetSet = discoverOptimizeTargets(resolved.agentFile);
    rejectGoalForNodeWithRequiredArgs(targetSet, resolved.node);
    return { agent: opts.agent, inputs: [{ id: "input-1", node: resolved.node, args: {}, goal: opts.goal ?? "" }] };
  }
  const loaded = loadInputs(path.resolve(opts.tasks ?? ""), deps.makeId ?? nanoid);
  const inputs: Input[] = loaded.map((input) => ({ ...input, node: input.node ?? resolved.node }));
  return { agent: opts.agent, inputs };
}

/** Build the optimizer config: the goal-judge grader plus run policy/artifacts settings. */
export function buildConfig(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): BaseOptimizerConfig {
  const config = opts.config ?? {};
  const base: BaseOptimizerConfig = {
    graders: [new LlmJudge({ name: "goal", agencyFile: GOAL_JUDGE_FILE, goalPath: ["goal"] })],
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
    seed: opts.seed,
    config,
    runsDir: path.resolve(opts.runsDir ?? config.eval?.optimizeRunsDir ?? path.join(config.eval?.runsDir ?? "runs", "optimize")),
    runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    writeback: opts.writeback ?? true,
    mutatorModel: opts.mutatorModel,
    verbosity: opts.silent ? "silent" : "default",
  };
  // GEPA needs a minibatch size; it rides on the shared config and the factory casts to GepaConfig.
  if (opts.optimizer === "gepa") return { ...base, minibatch: opts.minibatch ?? DEFAULT_MINIBATCH } as BaseOptimizerConfig;
  return base;
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
