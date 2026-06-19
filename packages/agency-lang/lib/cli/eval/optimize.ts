import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadInputs } from "@/eval/loadInputs.js";
import type { BaseGrader } from "@/optimize/grading/baseGrader.js";
import { LlmJudge } from "@/optimize/grading/graders/llmJudge.js";
import type { Input } from "@/optimize/grading/types.js";
import { loadGradingModule } from "@/optimize/gradingModule.js";
import { loadOptimizerModule } from "@/optimize/optimizerModule.js";
import type { BaseOptimizerConfig, Optimizer, OptimizeTarget } from "@/optimize/optimizer.js";
import { writeReport } from "@/optimize/report.js";
import { splitInputs } from "@/optimize/validationSplit.js";
import { DEFAULT_OPTIMIZER, getOptimizer } from "@/optimize/registry.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "@/optimize/targets.js";
import type { OptimizeResult } from "@/optimize/types.js";
import { parseAgency } from "@/parser.js";

import { resolveEvalRunTarget } from "./run.js";

export type EvalOptimizeOptions = {
  agent: string;
  inputs?: string;
  goal?: string;
  graders?: string;
  validationInputs?: string;
  validationSplit?: number;
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

export async function evalOptimize(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps = {},
): Promise<OptimizeResult> {
  const target = buildTarget(opts, deps);
  const config = await buildConfig(opts, deps);
  const optimizerRef = resolveOptimizeSettings(opts).optimizer ?? DEFAULT_OPTIMIZER;
  const optimizer = await resolveOptimizer(optimizerRef, config, deps);
  const result = await optimizer.optimize(target);
  // Persist the run summary so the path printed by the CLI actually exists.
  if (result.runDir) {
    fs.mkdirSync(result.runDir, { recursive: true });
    fs.writeFileSync(path.join(result.runDir, "summary.json"), JSON.stringify(result, null, 2));
    const ignoresValidation = optimizer.name !== "greedy";   // only greedy selects by validation
    writeReport(result.runDir, result, {
      optimizer: optimizer.name,
      graders: config.graders.map((g) => g.name()),
      trainObjective: result.trainObjective,
      validationObjective: result.validationObjective,
      validationConfiguredButUnused: ignoresValidation && (target.validationInputs?.length ?? 0) > 0,
    });
  }
  return result;
}

/** A built-in name vs a path to a TS/JS module. */
function looksLikePath(ref: string): boolean {
  return /[\\/]/.test(ref) || ref.endsWith(".ts") || ref.endsWith(".js") || ref.endsWith(".mjs");
}

/** Resolve `--optimizer` to an Optimizer: a path loads a user module, a bare name
 *  uses the built-in registry. The result is used structurally ({ name, optimize }). */
async function resolveOptimizer(ref: string, config: BaseOptimizerConfig, deps: EvalOptimizeDeps): Promise<Optimizer> {
  if (!looksLikePath(ref)) return (deps.getOptimizer ?? getOptimizer)(ref, config);
  const factory = await loadOptimizerModule(ref);
  const optimizer = factory(config);
  if (!optimizer || typeof optimizer.optimize !== "function" || typeof optimizer.name !== "string") {
    throw new Error(`Optimizer module ${ref} must default-export (config) => Optimizer ({ name, optimize }).`);
  }
  return optimizer;
}

/** Optimize allows --inputs and --goal together (--inputs = data, --goal =
 *  overall-goal default). Only --goal → a single synthetic input. */
/**
 * Which input source to use. `--inputs` and `--goal` may be combined: when
 * `--inputs` is present it wins (the suite is the data) and `--goal` becomes the
 * overall-goal default for inputs that omit one (filled in by `withDefaults`).
 * `--goal` alone means one synthetic no-arg input. At least one is required.
 */
function optimizeInputSelection(opts: EvalOptimizeOptions): "inputs" | "goal" {
  if (opts.inputs) return "inputs";
  if (opts.goal) return "goal";
  throw new Error("Provide --inputs (optionally with --goal as the overall goal), or --goal");
}

/** Effective optimize settings: CLI flags override agency.json's eval.optimize. */
function resolveOptimizeSettings(opts: EvalOptimizeOptions) {
  const cfg = opts.config?.eval?.optimize;
  return {
    goal: opts.goal ?? cfg?.goal,
    gradersPath: opts.graders ?? cfg?.graders,
    optimizer: opts.optimizer ?? cfg?.optimizer,
    inputsPath: opts.inputs,
    validationInputsPath: opts.validationInputs ?? cfg?.validation?.inputs,
    validationSplit: opts.validationSplit ?? cfg?.validation?.split,
    seed: opts.seed ?? 0,
  };
}

/** Fill in the default node and overall goal for inputs that omit them. */
function withDefaults(inputs: Input[], node: string, goal?: string): Input[] {
  return inputs.map((input) => {
    const out: Input = { ...input, node: input.node ?? node };
    if (out.goal === undefined && goal !== undefined) out.goal = goal;
    return out;
  });
}

/** Load + normalize the train inputs, plus a validation set when configured.
 *  The `load` closure is reused for both — no duplicated normalization. */
function provisionInputs(
  s: ReturnType<typeof resolveOptimizeSettings>,
  node: string,
  requireGoal: boolean,
  deps: EvalOptimizeDeps,
): { inputs: Input[]; validationInputs?: Input[] } {
  const load = (p: string) =>
    withDefaults(loadInputs(path.resolve(p), deps.makeId ?? nanoid, { requireGoal }), node, s.goal);
  const inputs = load(s.inputsPath ?? "");
  if (s.validationInputsPath) return { inputs, validationInputs: load(s.validationInputsPath) };
  if (s.validationSplit !== undefined) {
    const { train, validation } = splitInputs(inputs, s.validationSplit, s.seed);
    return { inputs: train, validationInputs: validation };
  }
  return { inputs };
}

/** Build the optimize target: the agent plus the inputs to run it on (from --goal or --inputs). */
export function buildTarget(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): OptimizeTarget {
  const resolved = resolveEvalRunTarget(opts.agent);
  if (optimizeInputSelection(opts) === "goal") return goalTarget(opts, resolved);
  const s = resolveOptimizeSettings(opts);
  // A per-input goal is required only when nothing else supplies one: no custom
  // grading module AND no overall --goal default to fall back on.
  const requireGoal = !s.gradersPath && s.goal === undefined;
  const { inputs, validationInputs } = provisionInputs(s, resolved.node, requireGoal, deps);
  const target: OptimizeTarget = { agent: opts.agent, inputs };
  if (validationInputs) target.validationInputs = validationInputs;
  return target;
}

/** The --goal-only case: one synthetic no-arg input carrying the overall goal. */
function goalTarget(opts: EvalOptimizeOptions, resolved: ReturnType<typeof resolveEvalRunTarget>): OptimizeTarget {
  const targetSet = discoverOptimizeTargets(resolved.agentFile);
  rejectGoalForNodeWithRequiredArgs(targetSet, resolved.node);
  return { agent: opts.agent, inputs: [{ id: "input-1", node: resolved.node, args: {}, goal: opts.goal ?? "" }] };
}

/** Build the optimizer config: the grader set (custom module or the default goal judge) plus run policy. */
export async function buildConfig(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): Promise<BaseOptimizerConfig> {
  const config = opts.config ?? {};
  const s = resolveOptimizeSettings(opts);
  const graders: BaseGrader[] = s.gradersPath
    ? await loadGradingModule(s.gradersPath, config)
    : [new LlmJudge({ name: "goal" })];
  const base: BaseOptimizerConfig = {
    graders,
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
  if (s.optimizer === "gepa") return { ...base, minibatch: opts.minibatch ?? DEFAULT_MINIBATCH } as BaseOptimizerConfig;
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
        "Use --inputs inputs.json to provide args for this agent.",
      );
    }
  }
}
