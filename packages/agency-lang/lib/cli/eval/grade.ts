import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { gradeSuite } from "@/eval/grading/gradeSuite.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";

import { resolveGraders } from "./graders.js";

export type EvalGradeOptions = {
  /** Path to a TypeScript grading module. Defaults to `eval.graders`, then the goal judge. */
  graders?: string;
  /** Also write the grading summary here, as JSON. */
  out?: string;
  config?: AgencyConfig;
};

/**
 * Score a run directory. Never re-executes the agent. Every pass appends
 * `score` annotations to the directory — a re-grade sits beside the earlier
 * ones, never over them — and prints the objective.
 */
export async function evalGrade(runDir: string, opts: EvalGradeOptions): Promise<EvalRunGrading> {
  const config = opts.config ?? {};
  const resolvedRunDir = path.resolve(runDir);
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

  const { grading } = await gradeSuite(resolvedRunDir, graders, config);

  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, JSON.stringify(grading, null, 2));
  }
  return grading;
}
