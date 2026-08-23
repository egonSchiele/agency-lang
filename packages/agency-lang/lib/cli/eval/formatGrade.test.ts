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
  it("prints the grading cost after the mean when judge calls cost money", () => {
    const result: EvalGradeResult = {
      runs: [
        { dir: "/runs/x/a", grading: grading("a", 1, [{ grader: "j", kind: "scalar", value: 1 }]) },
        {
          dir: "/runs/x/b",
          grading: grading("b", 0.5, [{ grader: "j", kind: "scalar", value: 0.5 }]),
        },
      ],
      judgeCostUsd: 0.1234,
      mean: 0.75,
      gatesPassed: true,
      batches: [],
    };
    const lines = formatGradeResult(result).map(stripAnsi);
    expect(lines).toContain("mean 0.750 over 2 runs");
    expect(lines).toContain("grading cost: $0.12");
  });

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
      judgeCostUsd: 0,
      mean: 0.75,
      gatesPassed: true,
      batches: [],
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
      judgeCostUsd: 0,
      mean: 1,
      gatesPassed: true,
      batches: [],
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
      judgeCostUsd: 0,
      mean: 0.5,
      gatesPassed: false,
      batches: [],
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

describe("formatGradeResult with trial batches", () => {
  const fib = grading("fib", 1, [{ grader: "g", kind: "binary", pass: true }]);

  it("one batch of several trials: per-test mean ± SE and the batch accuracy after the run blocks", () => {
    const result: EvalGradeResult = {
      runs: [{ dir: "/runs/b1/fib/1", grading: fib }],
      judgeCostUsd: 0,
      mean: 1,
      gatesPassed: true,
      batches: [
        {
          batch: "b1",
          trials: 3,
          accuracy: 0.5,
          standardError: 0.1,
          totalCostUsd: 6,
          totalDurationMs: 0,
          tests: [
            {
              testId: "fib",
              trials: 3,
              judgeCostUsd: 0,
              mean: 2 / 3,
              standardError: 1 / 3,
              meanCostUsd: 1,
              meanDurationMs: 0,
            },
            {
              testId: "sum",
              trials: 3,
              judgeCostUsd: 0,
              mean: null,
              standardError: null,
              meanCostUsd: 1,
              meanDurationMs: 0,
            },
          ],
        },
      ],
    };
    const lines = formatGradeResult(result).map(stripAnsi);
    expect(lines).toEqual([
      "fib  score 1.000",
      "  g            pass",
      "fib  score 0.667 ± 0.333 (3 trials, $1.00 each)",
      "sum  score no scores (3 trials, $1.00 each)",
      "accuracy 0.500 ± 0.100 over 2 tests × 3 trials, $6.00",
    ]);
  });

  it("several batches: each block is headed by its batch id, in order", () => {
    const batch = (id: string, accuracy: number) => ({
      batch: id,
      trials: 2,
      accuracy,
      standardError: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      tests: [
        {
          testId: "fib",
          trials: 2,
          judgeCostUsd: 0,
          mean: accuracy,
          standardError: 0,
          meanCostUsd: 0,
          meanDurationMs: 0,
        },
      ],
    });
    const result: EvalGradeResult = {
      runs: [],
      judgeCostUsd: 0,
      mean: 0,
      gatesPassed: true,
      batches: [batch("b1", 1), batch("b2", 0)],
    };
    expect(formatGradeResult(result).map(stripAnsi)).toEqual([
      "batch b1",
      "fib  score 1.000 ± 0.000 (2 trials, $0.00 each)",
      "accuracy 1.000 ± 0.000 over 1 test × 2 trials, $0.00",
      "batch b2",
      "fib  score 0.000 ± 0.000 (2 trials, $0.00 each)",
      "accuracy 0.000 ± 0.000 over 1 test × 2 trials, $0.00",
    ]);
  });
});

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
