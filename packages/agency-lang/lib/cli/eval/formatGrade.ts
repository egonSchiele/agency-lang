import { ttyColor } from "@/utils/termcolors.js";

import type { EvalGradeResult } from "./grade.js";

/**
 * `eval grade` output: one block per run, the test id and its score on the
 * first line, then one line per grader with that grader's score, then the
 * mean over the group. The score is the weighted mean of the graders' scores,
 * zeroed when a must-pass grader fails or the run did not finish.
 */
export function formatGradeResult(result: EvalGradeResult): string[] {
  const lines: string[] = [];
  for (const run of result.runs) {
    for (const input of run.grading.perInput) {
      lines.push(`${ttyColor.green(input.inputId)}  score ${colorScore(input.objective)}`);
      for (const grade of input.grades) {
        const value =
          grade.kind === "scalar" ? grade.value.toFixed(3) : grade.pass ? "pass" : "fail";
        lines.push(`  ${grade.grader.padEnd(12)} ${value}`);
        if (grade.feedback) lines.push(`      ${grade.feedback}`);
      }
      if (input.ungradedReason !== undefined) {
        lines.push(`  ${ttyColor.red(`not graded — ${input.ungradedReason}`)}`);
      }
    }
  }
  if (result.runs.length > 1) {
    lines.push(`mean ${colorScore(result.mean)} over ${result.runs.length} runs`);
  }
  return lines;
}

function colorScore(score: number): string {
  const text = score.toFixed(3);
  if (score === 0) return ttyColor.red(text);
  if (score === 1) return ttyColor.green(text);
  return text;
}
