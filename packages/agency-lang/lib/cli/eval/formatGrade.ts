import type { BatchStatistics, TestStatistics } from "@/eval/batchStatistics.js";
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
 * zeroed when a must-pass grader fails or the run did not finish. A batch
 * that ran several trials adds a block of per-test `mean ± SE` lines and its
 * accuracy; several such batches are each headed by their batch id.
 */
export function formatGradeResult(result: EvalGradeResult): string[] {
  return [
    ...result.runs.flatMap(formatRun),
    ...formatGroupSummary(result),
    ...result.batches.flatMap((batch) => formatBatch(batch, result.batches.length > 1)),
  ];
}

function formatBatch(batch: BatchStatistics, headed: boolean): string[] {
  const heading = headed ? [ttyColor.bold(`batch ${batch.batch ?? "(none)"}`)] : [];
  const accuracy = batch.accuracy === null ? "no scores" : formatScore(batch.accuracy);
  return [
    ...heading,
    ...batch.tests.map(formatTestStatistics),
    `accuracy ${withStandardError(accuracy, batch.standardError)} over ` +
      `${batch.tests.length} ${plural(batch.tests.length, "test")} × ${batch.trials} trials, ` +
      `$${batch.totalCostUsd.toFixed(2)}`,
  ];
}

function formatTestStatistics(test: TestStatistics): string {
  const mean = test.mean === null ? "no scores" : formatScore(test.mean);
  return (
    `${ttyColor.green(test.testId)}  score ${withStandardError(mean, test.standardError)} ` +
    `(${test.trials} trials, $${test.meanCostUsd.toFixed(2)} each)`
  );
}

function withStandardError(value: string, standardError: number | null): string {
  return standardError === null ? value : `${value} ± ${formatScore(standardError)}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
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
