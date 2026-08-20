import { formatScore } from "@/eval/grading/gradeBreakdown.js";
import { ttyColor } from "@/utils/termcolors.js";

import type { EvalGradeResult } from "./grade.js";

const GRADER_COLUMN_WIDTH = 12;

type GradedRun = EvalGradeResult["runs"][number];
type GradedInput = GradedRun["grading"]["perInput"][number];
type Grade = GradedInput["grades"][number];

/**
 * `eval grade` output: one block per run, the test id and its score on the
 * first line, then one line per grader with that grader's score, then the
 * mean over the group. The score is the weighted mean of the graders' scores,
 * zeroed when a must-pass grader fails or the run did not finish.
 */
export function formatGradeResult(result: EvalGradeResult): string[] {
  return [...result.runs.flatMap(formatRun), ...formatGroupSummary(result)];
}

function formatRun(run: GradedRun): string[] {
  return run.grading.perInput.flatMap(formatInput);
}

function formatInput(input: GradedInput): string[] {
  return [
    `${ttyColor.green(input.inputId)}  score ${formatScore(input.objective)}`,
    ...(input.description === undefined ? [] : [`  ${ttyColor.dim(input.description)}`]),
    ...input.grades.flatMap(formatGrade),
    ...formatUngradedReason(input.ungradedReason),
  ];
}

function formatGrade(grade: Grade): string[] {
  const line = `  ${grade.grader.padEnd(GRADER_COLUMN_WIDTH)} ${formatGradeValue(grade)}`;
  if (grade.feedback === undefined || grade.feedback === "") {
    return [line];
  }
  return [line, `      ${grade.feedback}`];
}

function formatGradeValue(grade: Grade): string {
  if (grade.kind === "scalar") {
    return grade.value.toFixed(3);
  }
  return grade.pass ? "pass" : "fail";
}

function formatUngradedReason(reason: string | undefined): string[] {
  if (reason === undefined) {
    return [];
  }
  return [`  ${ttyColor.red(`not graded — ${reason}`)}`];
}

function formatGroupSummary(result: EvalGradeResult): string[] {
  if (result.runs.length > 1) {
    return [`mean ${formatScore(result.mean)} over ${result.runs.length} runs`];
  }
  return [];
}
