import type { ImportOutcome, ImportResult } from "./importHarbor.js";

const MAX_LISTED_TESTS = 10;

/** The lines `agency eval import-harbor` prints when it finishes. */
export function formatImportSummary(result: ImportResult): string[] {
  const lines = [
    ...result.outcomes.flatMap(failureLine),
    ...result.problems.map((problem) => `problem: ${problem.path}: ${problem.reason}`),
    countsLine(result),
  ];
  const uneven = unevenTrialsLine(result.plan.trialCounts);
  if (uneven !== null) {
    lines.push(uneven);
  }
  if (result.plan.unknownExceptions.length > 0) {
    lines.push(
      `unknown exception types (counted as void): ${result.plan.unknownExceptions.join(", ")}`,
    );
  }
  lines.push(`upload with: agency eval upload ${result.uploadPath}`);
  return lines;
}

export function hasErrors(result: ImportResult): boolean {
  return (
    result.problems.length > 0 || result.outcomes.some((outcome) => outcome.status === "failed")
  );
}

function failureLine(outcome: ImportOutcome): string[] {
  return outcome.status === "failed" ? [`failed: ${outcome.path}: ${outcome.error}`] : [];
}

function countsLine(result: ImportResult): string {
  const count = (status: ImportOutcome["status"]): number =>
    result.outcomes.filter((outcome) => outcome.status === status).length;
  const voidRuns = result.plan.runs.filter((run) => run.payload.ended === "void").length;
  return [
    `${count("imported")} imported`,
    `${count("present")} present`,
    `${count("scored")} scored`,
    `${voidRuns} void`,
    `${count("failed")} failed`,
  ].join(" · ");
}

/** Null when every test has the same number of trials. Otherwise each group,
 *  most trials first, naming the tests in every group but the first. */
function unevenTrialsLine(trialCounts: Record<number, string[]>): string | null {
  const groups = Object.entries(trialCounts)
    .map(([trials, tests]) => ({ trials: Number(trials), tests }))
    .sort((left, right) => right.trials - left.trials);
  if (groups.length < 2) {
    return null;
  }
  const parts = groups.map((group, index) => {
    const summary = `${plural(group.trials, "trial")}: ${plural(group.tests.length, "test")}`;
    return index === 0 ? summary : `${summary} (${listed(group.tests)})`;
  });
  return `uneven trials: ${parts.join("; ")}`;
}

function listed(tests: string[]): string {
  const shown = tests.slice(0, MAX_LISTED_TESTS);
  return tests.length > MAX_LISTED_TESTS ? [...shown, "…"].join(", ") : shown.join(", ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
