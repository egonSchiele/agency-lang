import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadInputs } from "@/eval/loadInputs.js";
import type { GraderSource } from "@/eval/grading/gradeRun.js";
import type { Test } from "@/eval/grading/types.js";
import { loadGradingModule } from "@/eval/grading/gradingModule.js";
import { loadOptimizerModule } from "@/optimize/optimizerModule.js";
import type { BaseOptimizerConfig, Optimizer, OptimizeTarget } from "@/optimize/optimizer.js";
import { writeReport } from "@/optimize/report.js";
import { splitInputs } from "@/optimize/validationSplit.js";
import { DEFAULT_OPTIMIZER, getOptimizer } from "@/optimize/registry.js";
import type { OptimizeResult } from "@/optimize/types.js";

import { assertTargetMatchesInputs, resolveEvalRunTarget } from "@/agentTarget.js";

export type EvalOptimizeOptions = {
  agent: string;
  suite?: string;
  goal?: string;
  graders?: string;
  validationSuite?: string;
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
    // A validation set was provided but the optimizer didn't select on it (it
    // produced no validation objective) — true for a custom optimizer that ignores it.
    const validationConfiguredButUnused =
      (target.validationInputs?.length ?? 0) > 0 && result.validationObjective === undefined;
    writeReport(result.runDir, result, {
      optimizer: optimizer.name,
      graders:
        config.graders.kind === "override"
          ? config.graders.graders.map((g) => g.name())
          : ["(per-test)"],
      trainObjective: result.trainObjective,
      validationObjective: result.validationObjective,
      validationConfiguredButUnused,
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
async function resolveOptimizer(
  ref: string,
  config: BaseOptimizerConfig,
  deps: EvalOptimizeDeps,
): Promise<Optimizer> {
  if (!looksLikePath(ref)) return (deps.getOptimizer ?? getOptimizer)(ref, config);
  const factory = await loadOptimizerModule(ref);
  const optimizer = factory(config);
  if (
    !optimizer ||
    typeof optimizer.optimize !== "function" ||
    typeof optimizer.name !== "string"
  ) {
    throw new Error(
      `Optimizer module ${ref} must default-export (config) => Optimizer ({ name, optimize }).`,
    );
  }
  return optimizer;
}

/**
 * Which input source to use. `--suite` and `--goal` may be combined: when
 * `--suite` is present it wins (the suite is the data) and `--goal` becomes the
 * overall-goal default for inputs that omit one (filled in by `withDefaults`).
 * `--goal` alone means one synthetic input whose task is the goal text. At
 * least one is required.
 */
function optimizeInputSelection(opts: EvalOptimizeOptions): "inputs" | "goal" {
  if (opts.suite) return "inputs";
  if (opts.goal) return "goal";
  throw new Error("Provide --suite (optionally with --goal as the overall goal), or --goal");
}

/** Effective optimize settings: CLI flags override agency.json's eval.optimize. */
function resolveOptimizeSettings(opts: EvalOptimizeOptions) {
  const cfg = opts.config?.eval?.optimize;
  return {
    goal: opts.goal ?? cfg?.goal,
    gradersPath: opts.graders ?? cfg?.graders,
    optimizer: opts.optimizer ?? cfg?.optimizer,
    inputsPath: opts.suite,
    validationInputsPath: opts.validationSuite ?? cfg?.validation?.inputs,
    validationSplit: opts.validationSplit ?? cfg?.validation?.split,
    seed: opts.seed ?? 0,
  };
}

/** Fill in the overall goal for inputs that omit one. */
function withDefaults(inputs: Test[], goal?: string): Test[] {
  return inputs.map((input) => {
    if (input.goal === undefined && goal !== undefined) return { ...input, goal };
    return input;
  });
}

/** Load + normalize the train inputs, plus a validation set when configured.
 *  The `load` closure is reused for both — no duplicated normalization. */
function provisionInputs(
  s: ReturnType<typeof resolveOptimizeSettings>,
  requireGoal: boolean,
  deps: EvalOptimizeDeps,
): { inputs: Test[]; validationInputs?: Test[] } {
  const load = (p: string) =>
    withDefaults(loadInputs(path.resolve(p), deps.makeId ?? nanoid, { requireGoal }), s.goal);
  const inputs = load(s.inputsPath ?? "");
  if (s.validationInputsPath) return { inputs, validationInputs: load(s.validationInputsPath) };
  if (s.validationSplit !== undefined) {
    const { train, validation } = splitInputs(inputs, s.validationSplit, s.seed);
    return { inputs: train, validationInputs: validation };
  }
  return { inputs };
}

/** Build the optimize target: the agent plus the inputs to run it on (from --goal or --suite). */
export function buildTarget(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): OptimizeTarget {
  const resolved = resolveEvalRunTarget(opts.agent);
  const target =
    optimizeInputSelection(opts) === "goal" ? goalTarget(opts) : suiteTarget(opts, deps);
  // Fail here, once, rather than as a run failure per candidate iteration.
  assertTargetMatchesInputs({ kind: "file", ...resolved }, [
    ...target.inputs,
    ...(target.validationInputs ?? []),
  ]);
  return target;
}

function suiteTarget(opts: EvalOptimizeOptions, deps: EvalOptimizeDeps): OptimizeTarget {
  const s = resolveOptimizeSettings(opts);
  // A per-input goal is required only when nothing else supplies one: no custom
  // grading module AND no overall --goal default to fall back on.
  const requireGoal = !s.gradersPath && s.goal === undefined;
  const { inputs, validationInputs } = provisionInputs(s, requireGoal, deps);
  const target: OptimizeTarget = { agent: opts.agent, inputs };
  if (validationInputs) target.validationInputs = validationInputs;
  return target;
}

/** The --goal-only case: one synthetic input where instruction and criterion
 *  coincide — the goal text is delivered as the node's task. */
function goalTarget(opts: EvalOptimizeOptions): OptimizeTarget {
  return {
    agent: opts.agent,
    inputs: [{ id: "input-1", input: opts.goal ?? "", goal: opts.goal ?? "" }],
  };
}

/** Build the optimizer config: the grader source (an explicit --graders module
 *  overrides every test's own; otherwise each test grades itself by the copy
 *  its run directory stores, the goal judge for tests with none) plus run
 *  policy. */
export async function buildConfig(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps,
): Promise<BaseOptimizerConfig> {
  const config = opts.config ?? {};
  const s = resolveOptimizeSettings(opts);
  const graders: GraderSource = s.gradersPath
    ? { kind: "override", graders: await loadGradingModule(s.gradersPath, config) }
    : { kind: "snapshot" };
  const base: BaseOptimizerConfig = {
    graders,
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
    seed: opts.seed,
    config,
    runsDir: path.resolve(
      opts.runsDir ??
        config.eval?.optimizeRunsDir ??
        path.join(config.eval?.runsDir ?? "runs", "optimize"),
    ),
    runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    writeback: opts.writeback ?? true,
    mutatorModel: opts.mutatorModel,
    verbosity: opts.silent ? "silent" : "default",
  };
  // GEPA needs a minibatch size; it rides on the shared config and the factory casts to GepaConfig.
  if (s.optimizer === "gepa")
    return { ...base, minibatch: opts.minibatch ?? DEFAULT_MINIBATCH } as BaseOptimizerConfig;
  return base;
}
