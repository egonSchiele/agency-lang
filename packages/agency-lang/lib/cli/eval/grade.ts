import * as fs from "fs";

import type { AgencyConfig } from "@/config.js";
import { gradeSuite } from "@/eval/grading/gradeSuite.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";
import { findRunDirectories, uniqueRunDirectories } from "@/runDirectory/findRuns.js";

import { goalJudgeGraders, resolveGraders } from "./graders.js";

export type EvalGradeOptions = {
  /** Path to a TypeScript grading module. Defaults to `eval.graders`, then the goal judge. */
  graders?: string;
  /** Judge every trace against this goal with the bundled goal judge (a test's
   *  own recorded goal still wins). Not combined with `graders`, and it sets
   *  aside a configured `eval.graders` module too: a module brings its own
   *  criteria, and `--goal` names the criterion. */
  goal?: string;
  /** Also write the grading summary here, as JSON. */
  out?: string;
  config?: AgencyConfig;
};

/** One graded run directory and the mean over them all. */
export type EvalGradeResult = {
  runs: { dir: string; grading: EvalRunGrading }[];
  /** Mean objective over the runs graded. */
  mean: number;
  /** Every run passed its gates. */
  gatesPassed: boolean;
};

/** The command's own preconditions, checked before anything loads: the two
 *  ways of saying "judge against this" are exclusive, and the targets must
 *  hold run directories (a bare statelog copied into a folder is the common
 *  miss). Returns canonical run directories to grade, duplicates removed by
 *  physical identity: `eval grade runs/suite runs/suite/a` grades `a` once. */
export function validateGradeTarget(targets: string[], opts: EvalGradeOptions): string[] {
  if (opts.graders !== undefined && opts.goal !== undefined) {
    throw new Error(
      "Provide only one of --graders or --goal: a grading module carries its own criteria " +
        "(give LlmJudge a goal there instead).",
    );
  }
  return uniqueRunDirectories(findRunDirectories(targets));
}

/** The grader set `eval grade` runs with; see `resolveGraders` for the precedence. */
export async function gradersFor(opts: EvalGradeOptions, config: AgencyConfig) {
  if (opts.goal !== undefined) return goalJudgeGraders();
  return resolveGraders(opts.graders, undefined, config);
}

/**
 * Score run directories, or every run directory in groups. Never re-executes
 * the agent. Each run gets its own grading pass, appended to ITS
 * `annotations.jsonl` — a re-grade sits beside the earlier ones, never over
 * them.
 */
export async function evalGrade(
  targets: string[],
  opts: EvalGradeOptions,
): Promise<EvalGradeResult> {
  const config = opts.config ?? {};
  const runDirs = validateGradeTarget(targets, opts);
  // `grade` is undefined here: there is no point running this command with
  // grading switched off, so the same resolver's default path applies. An
  // explicit --graders overrides every test's recorded graders; otherwise
  // per-test graders apply, with the config module / goal judge as fallback.
  // --goal promises the goal judge, so it never reaches the config module.
  const graders = await gradersFor(opts, config);
  // resolveGraders only returns undefined for --no-grade, which this command never
  // passes, and otherwise falls back to the goal judge — so the reachable case is a
  // grading module that default-exports an empty array.
  if (!graders || (graders.mode === "override" && graders.graders.length === 0)) {
    throw new Error(`The grading module at ${opts.graders} exported no graders.`);
  }

  const runs: EvalGradeResult["runs"] = [];
  for (const dir of runDirs) {
    const { grading } = await gradeSuite(dir, graders, config, { defaultGoal: opts.goal });
    runs.push({ dir, grading });
  }
  const result: EvalGradeResult = {
    runs,
    mean: runs.reduce((sum, run) => sum + run.grading.objective, 0) / runs.length,
    gatesPassed: runs.every((run) => run.grading.gatesPassed),
  };

  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2));
  }
  return result;
}
