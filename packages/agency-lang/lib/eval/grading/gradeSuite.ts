import type { AgencyConfig } from "@/config.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";

import { AgencyRunner } from "./agencyRunner.js";
import { breakdown } from "./gradeBreakdown.js";
import { gradeRun, type SuiteGraders } from "./gradeRun.js";

/**
 * Score a finished run directory into an EvalRunGrading. Reads the run
 * directory, writes nothing — where the grading lands (summary.json, a
 * verifier dir, --out) stays the caller's decision. Shared by `eval run
 * --grade` and `eval grade`, which once carried this block as twins.
 */
export async function gradeSuite(
  runDir: string,
  suiteGraders: SuiteGraders,
  config: AgencyConfig,
): Promise<EvalRunGrading> {
  const scorecard = await gradeRun(runDir, {
    suiteGraders,
    runAgency: new AgencyRunner(config),
    config,
  });
  const perInput = breakdown(scorecard);
  // The graders that actually participated. With per-test graders the sets
  // differ across inputs, so the run-level list is their union; an advisory
  // grader behind a failed gate never ran and is honestly absent.
  const graderNames = [
    ...new Set(perInput.flatMap((input) => input.grades.map((grade) => grade.grader))),
  ];
  return {
    graders: graderNames,
    // objective(), not gatedObjective(): a gate-failed input already contributes
    // 0 to this mean. gatedObjective() would zero the WHOLE run when any single
    // input fails, so one flaky timeout out of fifty would report 0.00 and make
    // the tracked number useless. gatesPassed drives exit codes instead.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput,
  };
}
