import type { BaseGrader } from "./baseGrader.js";
import type { AgentRun, Grade, Input } from "./types.js";

export type GraderGrade = { grader: BaseGrader; grade: Grade };
export type InputGrades = { input: Input; run: AgentRun; grades: GraderGrade[]; gatesPassed: boolean };

/**
 * Weighted mean of every grade for one input: a scalar grade contributes its
 * value, a binary grade contributes 1.0 (pass) or 0.0 (fail). `mustPass` is an
 * orthogonal gate (a failed gate zeroes the whole input via the Scorecard); it
 * does not change whether a grade contributes here. An input with no grades
 * scores 0.
 */
export function inputObjective(grades: GraderGrade[]): number {
  const contributions = grades.map((g) => ({
    weight: g.grader.weight(),
    value: g.grade.score.kind === "scalar" ? g.grade.score.value : (g.grade.score.pass ? 1 : 0),
  }));
  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;
  return contributions.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight;
}

/** Per-candidate grading result: per-input grades plus derived gate/objective readouts. */
export class Scorecard {
  constructor(readonly perInput: InputGrades[]) {}

  gatesPassed(): boolean {
    return this.perInput.every((i) => i.gatesPassed);
  }

  /** Per-input objective; a gate-failed input scores 0. */
  inputScores(): number[] {
    return this.perInput.map((i) => (i.gatesPassed ? inputObjective(i.grades) : 0));
  }

  objective(): number {
    const scores = this.inputScores();
    if (scores.length === 0) return 0;
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  /** The canonical gate-aware comparison score: the raw objective when every
   *  `mustPass` gate is satisfied, otherwise 0. This is what every optimizer
   *  uses to compare candidates, and what `OptimizeResult.trainObjective` and
   *  `baselineObjective` report. Prefer this over inlining
   *  `s.gatesPassed() ? s.objective() : 0`. */
  gatedObjective(): number {
    return this.gatesPassed() ? this.objective() : 0;
  }
}
