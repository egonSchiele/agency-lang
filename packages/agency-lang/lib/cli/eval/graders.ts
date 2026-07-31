import type { AgencyConfig } from "@/config.js";
import { LlmJudge } from "@/eval/grading/graders/llmJudge.js";
import type { SuiteGraders } from "@/eval/grading/gradeRun.js";
import { loadGradingModule } from "@/eval/grading/gradingModule.js";

/**
 * The suite-level grader set and its meaning, decided at the command layer.
 * Precedence (matching flags-beat-config everywhere else): an explicit
 * --graders flag OVERRIDES every test's own graders — the experiment knob.
 * Otherwise the set is a FALLBACK for inputs that carry no graders of their
 * own: the eval.graders config module when present, else the bundled goal
 * judge (so a suite with goals scores without any grading module).
 * `--no-grade` opts out of scoring entirely (undefined).
 */
export async function resolveGraders(
  gradersFlag: string | undefined,
  grade: boolean | undefined,
  config: AgencyConfig,
): Promise<SuiteGraders | undefined> {
  if (grade === false) {
    return undefined;
  }
  if (gradersFlag !== undefined) {
    return { mode: "override", graders: await loadGradingModule(gradersFlag, config) };
  }
  const configPath = config.eval?.graders;
  if (configPath !== undefined) {
    return { mode: "fallback", graders: await loadGradingModule(configPath, config) };
  }
  return { mode: "fallback", graders: [new LlmJudge({ name: "goal" })] };
}
