import type { GraderGrade, Scorecard } from "./grading/scorecard.js";

export type GradeRow =
  | { grader: string; kind: "scalar"; value: number; feedback?: string }
  | { grader: string; kind: "binary"; pass: boolean; feedback?: string };

export type InputBreakdown = {
  inputId: string;
  output: unknown;
  objective: number;
  gatesPassed: boolean;
  grades: GradeRow[];
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
  const objectives = scorecard.inputScores();   // reuse the canonical gate→0 rule; don't re-derive it
  return scorecard.perInput.map((i, idx) => ({
    inputId: i.input.id ?? "(no id)",
    output: i.run.output,
    objective: objectives[idx],
    gatesPassed: i.gatesPassed,
    grades: i.grades.map(gradeRow),
  }));
}
