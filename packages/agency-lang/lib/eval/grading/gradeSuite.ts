import type { AgencyConfig } from "@/config.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";
import { recordGradingPass, type ScoreDraft } from "@/runDirectory/mutations.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { AgencyRunner } from "./agencyRunner.js";
import { breakdown } from "./gradeBreakdown.js";
import { gradeSnapshot, type SuiteGraders } from "./gradeRun.js";
import type { Scorecard } from "./scorecard.js";

export type GradeSuiteResult = {
  grading: EvalRunGrading;
  scorecard: Scorecard;
  passId: string | null;
};

/**
 * Score a run directory and record the verdict as one grading pass: one
 * `score` annotation per grader per trace, all sharing a fresh pass id, the
 * last one marking the pass complete. Reads one snapshot, grades it, converts
 * the grades to score drafts, and hands them to `recordGradingPass` — the run
 * directory owns how they land. Shared by every caller that grades a
 * directory (`eval grade`, the optimizer's per-candidate grading).
 *
 * `record: false` grades without writing (the optimizer's throwaway candidate
 * directories, and dry runs).
 */
export async function gradeSuite(
  runDir: string,
  suiteGraders: SuiteGraders,
  config: AgencyConfig,
  options: { record?: boolean } = {},
): Promise<GradeSuiteResult> {
  const snapshot = readRunDirectory(runDir, {
    reportWarning: (message) => console.warn(`grading: ${message}`),
  });
  const scorecard = await gradeSnapshot(snapshot, {
    suiteGraders,
    runAgency: new AgencyRunner(config),
    config,
  });
  const drafts = scoreDrafts(scorecard);
  let passId: string | null = null;
  if (options.record !== false && drafts.length > 0) {
    passId = recordGradingPass({ dir: runDir, scores: drafts }).passId;
  }
  return { grading: toGrading(scorecard), scorecard, passId };
}

/** One draft per grade that actually ran. A gate-failed or ungraded trace
 *  contributes the rows it has (its zero is the fold's business: a failed
 *  gate is a `pass: false` row, an ungraded trace has none). */
function scoreDrafts(scorecard: Scorecard): ScoreDraft[] {
  const drafts: ScoreDraft[] = [];
  for (const entry of scorecard.perInput) {
    if (entry.run === null) continue;
    for (const { grader, grade } of entry.grades) {
      const draft: ScoreDraft = {
        traceId: entry.run.traceId,
        annotator: grader.annotator(),
        name: grader.name(),
        score: grade.score,
        weight: grader.weight(),
        mustPass: grader.mustPass(),
      };
      if (grade.feedback !== undefined) draft.feedback = grade.feedback;
      if (grader.revision !== undefined) draft.gradersModule = grader.revision.split("@")[0];
      drafts.push(draft);
    }
  }
  return drafts;
}

function toGrading(scorecard: Scorecard): EvalRunGrading {
  const perInput = breakdown(scorecard);
  // The graders that actually participated. With per-test graders the sets
  // differ across traces, so the run-level list is their union; an advisory
  // grader behind a failed gate never ran and is honestly absent.
  const graderNames = [
    ...new Set(perInput.flatMap((input) => input.grades.map((grade) => grade.grader))),
  ];
  return {
    graders: graderNames,
    // objective(), not gatedObjective(): a gate-failed trace already contributes
    // 0 to this mean. gatedObjective() would zero the WHOLE run when any single
    // trace fails, so one flaky timeout out of fifty would report 0.00 and make
    // the tracked number useless. gatesPassed drives exit codes instead.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput,
  };
}
