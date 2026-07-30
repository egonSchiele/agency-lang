import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { breakdown } from "@/eval/grading/gradeBreakdown.js";
import { gradeRun } from "@/eval/grading/gradeRun.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";

import { resolveGraders } from "./run.js";

export type EvalGradeOptions = {
  /** Path to a TypeScript grading module. Defaults to `eval.graders`, then the goal judge. */
  graders?: string;
  /** Where to write the result. Defaults to `<runDir>/grading.json`. */
  out?: string;
  config?: AgencyConfig;
};

/**
 * Re-score a finished run directory. Never re-executes the agent, and never
 * rewrites summary.json — the run keeps the score it was born with, and
 * re-grades sit beside it.
 */
export async function evalGrade(
  runDir: string,
  opts: EvalGradeOptions,
): Promise<EvalRunGrading> {
  const config = opts.config ?? {};
  const resolvedRunDir = path.resolve(runDir);
  const gradersPath = opts.graders ?? config.eval?.graders;
  // `grade` is undefined here: there is no point running this command with
  // grading switched off, so the same resolver's default path applies.
  const graders = await resolveGraders(gradersPath, undefined, config);
  if (!graders || graders.length === 0) {
    throw new Error("No graders resolved; pass --graders <file> or set eval.graders in agency.json.");
  }

  const scorecard = await gradeRun(resolvedRunDir, {
    graders,
    runAgency: new AgencyRunner(config),
  });

  const grading: EvalRunGrading = {
    graders: graders.map((grader) => grader.name()),
    // objective(), not gatedObjective() — same reasoning as eval run: a
    // gate-failed input already contributes 0 to this mean, and zeroing the
    // whole run over one failure makes the number untrackable.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput: breakdown(scorecard),
  };

  fs.writeFileSync(
    opts.out ?? path.join(resolvedRunDir, "grading.json"),
    JSON.stringify(grading, null, 2),
  );
  return grading;
}
