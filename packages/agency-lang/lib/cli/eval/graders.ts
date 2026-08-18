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
    const graders = await loadGradingModule(configPath, config);
    // An empty module here would grade every graderless input with NOTHING:
    // objective 0.000, exit 0, no diagnostic — a misconfiguration reading as
    // "the agent failed". This branch is the only way a fallback set can be
    // empty (the goal-judge default never is), so the misconfiguration throw
    // lives precisely here.
    if (graders.length === 0) {
      throw new Error(`The grading module at ${configPath} exported no graders.`);
    }
    return { mode: "fallback", graders };
  }
  return goalJudgeGraders();
}

/** The bundled goal judge as the fallback set: what grades a test that
 *  carries no graders of its own when nothing else is configured, and what
 *  `eval grade --goal` always means (the goal is the criterion, so a
 *  configured grading module is set aside for that run). */
export function goalJudgeGraders(): SuiteGraders {
  return { mode: "fallback", graders: [new LlmJudge({ name: "goal" })] };
}
