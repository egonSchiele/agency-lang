import { describe, expect, it } from "vitest";

import type { EvalRunGrading } from "@/eval/runTypes.js";

import { formatGradeResult } from "./formatGrade.js";
import type { EvalGradeResult } from "./grade.js";

function grading(
  inputId: string,
  objective: number,
  grades: EvalRunGrading["perInput"][number]["grades"],
  ungradedReason?: string,
): EvalRunGrading {
  return {
    graders: grades.map((grade) => grade.grader),
    objective,
    gatesPassed: true,
    perInput: [{ inputId, output: null, objective, gatesPassed: true, grades, ungradedReason }],
  };
}

describe("formatGradeResult", () => {
  it("one block per test: the score line, then one line per grader with feedback, no mean for a single run", () => {
    const result: EvalGradeResult = {
      runs: [
        {
          dir: "/runs/x/a",
          grading: grading("a", 0.75, [
            { grader: "len", kind: "scalar", value: 0.5, feedback: "too short" },
            { grader: "gate", kind: "binary", pass: true },
          ]),
        },
      ],
      mean: 0.75,
      gatesPassed: true,
    };
    const lines = formatGradeResult(result).map(stripAnsi);
    expect(lines).toEqual([
      "a  score 0.750",
      "  len          0.500",
      "      too short",
      "  gate         pass",
    ]);
  });

  it("a test's description prints dim under its score line", () => {
    const withDescription = grading("a", 1, [{ grader: "gate", kind: "binary", pass: true }]);
    withDescription.perInput[0].description = "checks the agent reads between the lines";
    const result: EvalGradeResult = {
      runs: [{ dir: "/runs/x/a", grading: withDescription }],
      mean: 1,
      gatesPassed: true,
    };
    const lines = formatGradeResult(result).map(stripAnsi);
    expect(lines).toEqual([
      "a  score 1.000",
      "  checks the agent reads between the lines",
      "  gate         pass",
    ]);
  });

  it("a group: every run's block, an ungraded reason where there is one, then the mean over the runs", () => {
    const result: EvalGradeResult = {
      runs: [
        {
          dir: "/runs/x/a",
          grading: grading("a", 1, [{ grader: "g", kind: "binary", pass: true }]),
        },
        { dir: "/runs/x/b", grading: grading("b", 0, [], "the run ended with timeout") },
      ],
      mean: 0.5,
      gatesPassed: false,
    };
    const lines = formatGradeResult(result).map(stripAnsi);
    expect(lines).toEqual([
      "a  score 1.000",
      "  g            pass",
      "b  score 0.000",
      "  not graded — the run ended with timeout",
      "mean 0.500 over 2 runs",
    ]);
  });
});

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
