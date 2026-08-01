import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { writeVerifierGrading } from "@/eval/runArtifacts.js";
import type { EvalRunGrading, EvalRunResult } from "@/eval/runTypes.js";

import type { SuiteGraders } from "./gradeRun.js";
import { gradeSuite } from "./gradeSuite.js";

/**
 * Grade a finished run directory and record the verdict the standard way:
 * the verifier directory, and a `grading` block in summary.json. Reads the
 * summary back off disk rather than taking it in memory — the run directory
 * is the interface, on the way in AND on the way out
 * (docs/dev/eval-grading.md), so every graded run proves the artifacts
 * round-trip.
 */
export async function recordGrading(
  runDir: string,
  suiteGraders: SuiteGraders,
  config: AgencyConfig,
): Promise<EvalRunGrading> {
  const grading = await gradeSuite(runDir, suiteGraders, config);
  const summaryPath = path.join(runDir, "summary.json");
  let summary: EvalRunResult;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as EvalRunResult;
  } catch (error) {
    throw new Error(`could not read ${summaryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  summary.grading = grading;
  writeVerifierGrading(runDir, grading);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return grading;
}
