import type { AgencyConfig } from "@/config.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";

import { AgencyRunner } from "./agencyRunner.js";
import type { BaseGrader } from "./baseGrader.js";
import { breakdown } from "./gradeBreakdown.js";
import { gradeRun } from "./gradeRun.js";

/**
 * Score a finished run directory into an EvalRunGrading. Reads the run
 * directory, writes nothing — where the grading lands (summary.json, a
 * verifier dir, --out) stays the caller's decision. Shared by `eval run
 * --grade` and `eval grade`, which once carried this block as twins.
 */
export async function gradeSuite(
  runDir: string,
  graders: BaseGrader[],
  config: AgencyConfig,
): Promise<EvalRunGrading> {
  const scorecard = await gradeRun(runDir, { graders, runAgency: new AgencyRunner(config) });
  return {
    graders: graders.map((grader) => grader.name()),
    // objective(), not gatedObjective(): a gate-failed input already contributes
    // 0 to this mean. gatedObjective() would zero the WHOLE run when any single
    // input fails, so one flaky timeout out of fifty would report 0.00 and make
    // the tracked number useless. gatesPassed drives exit codes instead.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput: breakdown(scorecard),
  };
}
