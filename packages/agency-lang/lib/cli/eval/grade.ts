import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { gradeSuite } from "@/eval/grading/gradeSuite.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";

import { runDirPaths } from "@/runDirectory/runDir.js";

import { resolveGraders } from "./graders.js";

export type EvalGradeOptions = {
  /** Path to a TypeScript grading module. Defaults to `eval.graders`, then the goal judge. */
  graders?: string;
  /** The goal for the default judge, for every trace whose test recorded none.
   *  Not combined with `graders`: a module brings its own criteria. */
  goal?: string;
  /** Also write the grading summary here, as JSON. */
  out?: string;
  config?: AgencyConfig;
};

/** The command's own preconditions, checked before anything loads: the two
 *  ways of saying "judge against this" are exclusive, and the target must be
 *  a run directory (a bare statelog copied into a folder is the common miss). */
export function validateGradeTarget(runDir: string, opts: EvalGradeOptions): void {
  if (opts.graders !== undefined && opts.goal !== undefined) {
    throw new Error(
      "Provide only one of --graders or --goal: a grading module carries its own criteria " +
        "(give LlmJudge a goal there instead).",
    );
  }
  const statelog = runDirPaths(runDir).statelog;
  if (!fs.existsSync(statelog)) {
    throw new Error(
      `${runDir} is not a run directory: no ${path.basename(statelog)} in it. Build one with ` +
        `\`agency runs add ${runDir} --statelog <file>\` or run the agent with ` +
        `\`agency run --capture-workdir ${runDir} <file.agency>\`.`,
    );
  }
}

/**
 * Score a run directory. Never re-executes the agent. Every pass appends
 * `score` annotations to the directory — a re-grade sits beside the earlier
 * ones, never over them — and prints the objective.
 */
export async function evalGrade(runDir: string, opts: EvalGradeOptions): Promise<EvalRunGrading> {
  const config = opts.config ?? {};
  const resolvedRunDir = path.resolve(runDir);
  validateGradeTarget(resolvedRunDir, opts);
  // `grade` is undefined here: there is no point running this command with
  // grading switched off, so the same resolver's default path applies. An
  // explicit --graders overrides every test's recorded graders; otherwise
  // per-test graders apply, with the config module / goal judge as fallback.
  const graders = await resolveGraders(opts.graders, undefined, config);
  // resolveGraders only returns undefined for --no-grade, which this command never
  // passes, and otherwise falls back to the goal judge — so the reachable case is a
  // grading module that default-exports an empty array.
  if (!graders || (graders.mode === "override" && graders.graders.length === 0)) {
    throw new Error(`The grading module at ${opts.graders} exported no graders.`);
  }

  const { grading } = await gradeSuite(resolvedRunDir, graders, config, {
    defaultGoal: opts.goal,
  });

  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, JSON.stringify(grading, null, 2));
  }
  return grading;
}
