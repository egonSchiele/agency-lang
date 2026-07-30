import type { AgencyConfig } from "@/config.js";
import type { BaseGrader } from "@/eval/grading/baseGrader.js";
import { LlmJudge } from "@/eval/grading/graders/llmJudge.js";
import { loadGradingModule } from "@/eval/grading/gradingModule.js";

/**
 * What "no --graders" means, decided at the command layer rather than in the
 * library: the bundled goal judge, so a suite with goals scores without a
 * grading module. `--no-grade` opts out of scoring entirely.
 */
export async function resolveGraders(
  gradersPath: string | undefined,
  grade: boolean | undefined,
  config: AgencyConfig,
): Promise<BaseGrader[] | undefined> {
  if (grade === false) {
    return undefined;
  }
  if (gradersPath === undefined) {
    return [new LlmJudge({ name: "goal" })];
  }
  return loadGradingModule(gradersPath, config);
}
