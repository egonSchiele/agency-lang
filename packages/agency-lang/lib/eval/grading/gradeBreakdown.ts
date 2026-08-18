import { ttyColor } from "@/utils/termcolors.js";

import type { GraderGrade, Scorecard } from "./scorecard.js";

export type GradeRow =
  | { grader: string; kind: "scalar"; value: number; feedback?: string }
  | { grader: string; kind: "binary"; pass: boolean; feedback?: string };

export type InputBreakdown = {
  inputId: string;
  output: unknown;
  objective: number;
  gatesPassed: boolean;
  grades: GradeRow[];
  /** Set when the input scored 0 without being graded (errored run, or no output). */
  ungradedReason?: string;
};

/** One grade row. Shared fields computed once; the only branch is the
 *  tagged-union tail (scalar value vs binary pass). */
function gradeRow({ grader, grade }: GraderGrade): GradeRow {
  const base = { grader: grader.name(), ...(grade.feedback ? { feedback: grade.feedback } : {}) };
  return grade.score.kind === "scalar"
    ? { ...base, kind: "scalar", value: grade.score.value }
    : { ...base, kind: "binary", pass: grade.score.pass };
}

/** A serializable, human-renderable view of a Scorecard: per input, the output
 *  plus each grader's score and feedback. Used by the champion artifact and report. */
export function breakdown(scorecard: Scorecard): InputBreakdown[] {
  const objectives = scorecard.inputScores(); // reuse the canonical gate→0 rule; don't re-derive it
  return scorecard.perInput.map((i, idx) => ({
    inputId: i.test.id ?? "(no id)",
    output: i.run?.output ?? null,
    objective: objectives[idx],
    gatesPassed: i.gatesPassed,
    grades: i.grades.map(gradeRow),
    ungradedReason: i.ungradedReason,
  }));
}

/** One grader's aggregate result across every input it graded. */
export type GraderSummary =
  | { grader: string; kind: "binary"; passed: number; total: number }
  | { grader: string; kind: "scalar"; mean: number };

/** Every grade row, grouped by grader name, order of first appearance preserved. */
function gradesByGrader(perInput: InputBreakdown[]): Record<string, GradeRow[]> {
  const rows = perInput.flatMap((input) => input.grades);
  const names = rows.map((row) => row.grader);
  const uniqueNames = names.filter((name, index) => names.indexOf(name) === index);
  return Object.fromEntries(
    uniqueNames.map((name) => [name, rows.filter((row) => row.grader === name)]),
  );
}

/**
 * Aggregate grades into one summary per grader: a pass count for binary graders,
 * a mean for scalar ones. A grader with any scalar row is summarized as scalar.
 * Pure data — rendering is separate, so a JSON or HTML view reuses this untouched.
 */
export function summarizeGraders(perInput: InputBreakdown[]): GraderSummary[] {
  return Object.entries(gradesByGrader(perInput)).map(([grader, rows]) => {
    const scalars = rows.filter((row) => row.kind === "scalar");
    if (scalars.length === 0) {
      const binaries = rows.filter((row) => row.kind === "binary");
      return {
        grader,
        kind: "binary",
        passed: binaries.filter((row) => row.pass).length,
        total: binaries.length,
      };
    }
    const sum = scalars.reduce((total, row) => total + row.value, 0);
    return { grader, kind: "scalar", mean: sum / scalars.length };
  });
}

/** Inputs that scored 0 without being graded, paired with the reason. */
export function ungradedInputs(perInput: InputBreakdown[]): { inputId: string; reason: string }[] {
  return perInput.flatMap((input) =>
    input.ungradedReason === undefined
      ? []
      : [{ inputId: input.inputId, reason: input.ungradedReason }],
  );
}

/**
 * Render a grading result for a terminal. One line per grader, since that is
 * what tells you which aspect regressed; a per-input listing does not.
 *
 * Takes the parts rather than an EvalRunGrading to avoid a circular import —
 * runTypes.ts imports InputBreakdown from this file.
 */
export function formatGrading(objective: number, perInput: InputBreakdown[]): string[] {
  // Perfect green, zero red, in-between plain — the two ends are the ones a
  // reader scans for. ttyColor: plain text when piped.
  const objectiveText = objective.toFixed(3);
  const coloredObjective =
    objective === 0
      ? ttyColor.red(objectiveText)
      : objective === 1
        ? ttyColor.green(objectiveText)
        : objectiveText;
  return [
    `objective  ${coloredObjective}`,
    ...summarizeGraders(perInput).map(formatGraderSummary),
    ...ungradedInputs(perInput).map(
      (entry) =>
        `  ${ttyColor.green(entry.inputId)}  ${ttyColor.red(`not graded — ${entry.reason}`)}`,
    ),
  ];
}

function formatGraderSummary(summary: GraderSummary): string {
  if (summary.kind === "binary") {
    const counts = `${summary.passed}/${summary.total} pass`;
    return `  ${ttyColor.green(summary.grader)}  ${summary.passed === summary.total ? ttyColor.green(counts) : ttyColor.red(counts)}`;
  }
  return `  ${ttyColor.green(summary.grader)}  ${summary.mean.toFixed(3)}`;
}
