import type { BaseGrader } from "./baseGrader.js";
import type { AgentRun, Grade, Input } from "./types.js";

export type GraderGrade = { grader: BaseGrader; grade: Grade };
export type InputGrades = { input: Input; run: AgentRun; grades: GraderGrade[]; gatesPassed: boolean };

/** Weighted mean of the non-gating scalar grades for one input. */
export function inputObjective(grades: GraderGrade[]): number {
  const contributions = grades
    .filter((g) => !g.grader.isGate)
    .flatMap((g) => (g.grade.score.kind === "scalar" ? [{ weight: g.grader.weight, value: g.grade.score.value }] : []));
  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;
  return contributions.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight;
}

/** Per-candidate grading result: per-input grades plus derived gate/objective readouts. */
export class Scorecard {
  constructor(readonly perInput: InputGrades[]) {}

  get gatesPassed(): boolean {
    return this.perInput.every((i) => i.gatesPassed);
  }

  /** Per-input objective; a gate-failed input scores 0. */
  get inputScores(): number[] {
    return this.perInput.map((i) => (i.gatesPassed ? inputObjective(i.grades) : 0));
  }

  get objective(): number {
    const scores = this.inputScores;
    if (scores.length === 0) return 0;
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }
}
