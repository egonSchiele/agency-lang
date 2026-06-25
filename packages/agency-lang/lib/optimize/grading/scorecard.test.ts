import { describe, expect, it } from "vitest";

import { BaseGrader } from "./baseGrader.js";
import { Scorecard, type GraderGrade, type InputGrades } from "./scorecard.js";
import type { Grade, GraderOptions, Input } from "./types.js";

class StubGrader extends BaseGrader {
  protected readonly defaultName = "stub";
  constructor(options: GraderOptions = {}) {
    super(options);
  }
  protected _run(): Promise<Grade> {
    return Promise.resolve({ score: { kind: "scalar", value: 0 } });
  }
}

const input = (id: string): Input => ({ id, args: {} });
const scalarGrade = (grader: BaseGrader, value: number): GraderGrade => ({ grader, grade: { score: { kind: "scalar", value } } });

describe("Scorecard", () => {
  it("objective is the weighted mean of non-gating scalar grades, averaged across inputs", () => {
    const advisory = new StubGrader({ weight: 1 });
    const weighted = new StubGrader({ weight: 3 });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1), scalarGrade(weighted, 0)] },
      { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1), scalarGrade(weighted, 1)] },
    ];
    // input a: (1*1 + 3*0)/4 = 0.25 ; input b: (1*1 + 3*1)/4 = 1.0 ; mean = 0.625
    expect(new Scorecard(perInput).objective()).toBeCloseTo(0.625, 10);
  });

  it("a binary grade contributes 1.0/0.0 to the objective, like any metric", () => {
    const passing = new StubGrader({ weight: 1 });
    const failing = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      {
        input: input("a"),
        run: { output: null, recordPath: "" },
        gatesPassed: true,
        grades: [
          { grader: passing, grade: { score: { kind: "binary", pass: true } } },
          { grader: failing, grade: { score: { kind: "binary", pass: false } } },
        ],
      },
    ];
    // (1*1 + 1*0)/2 = 0.5
    expect(new Scorecard(perInput).objective()).toBeCloseTo(0.5, 10);
  });

  it("a binary-only grader (e.g. ExactMatch) yields a meaningful objective = accuracy", () => {
    const exact = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [{ grader: exact, grade: { score: { kind: "binary", pass: true } } }] },
      { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [{ grader: exact, grade: { score: { kind: "binary", pass: false } } }] },
    ];
    expect(new Scorecard(perInput).objective()).toBeCloseTo(0.5, 10);   // mean(1, 0)
  });

  it("a passing binary gate (mustPass) still contributes 1.0 to the objective", () => {
    const gate = new StubGrader({ mustPass: true, weight: 1 });
    const advisory = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      {
        input: input("a"),
        run: { output: null, recordPath: "" },
        gatesPassed: true,
        grades: [
          { grader: gate, grade: { score: { kind: "binary", pass: true } } },
          scalarGrade(advisory, 0.5),
        ],
      },
    ];
    // (1*1 + 1*0.5)/2 = 0.75
    expect(new Scorecard(perInput).objective()).toBeCloseTo(0.75, 10);
  });

  it("a passing scalar gate contributes its value to the objective", () => {
    const scalarGate = new StubGrader({ mustPass: true, weight: 1 });
    const advisory = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      {
        input: input("a"),
        run: { output: null, recordPath: "" },
        gatesPassed: true,
        grades: [scalarGrade(scalarGate, 0.4), scalarGrade(advisory, 0.8)],
      },
    ];
    // (1*0.4 + 1*0.8)/2 = 0.6
    expect(new Scorecard(perInput).objective()).toBeCloseTo(0.6, 10);
  });

  it("a gate-failed input scores 0 and drags the objective down", () => {
    const advisory = new StubGrader({ weight: 1 });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: false, grades: [scalarGrade(advisory, 1)] },
      { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1)] },
    ];
    const sc = new Scorecard(perInput);
    expect(sc.inputScores()).toEqual([0, 1]);
    expect(sc.objective()).toBeCloseTo(0.5, 10);
  });

  it("gatesPassed is true only when every input passed its gates", () => {
    const advisory = new StubGrader({ weight: 1 });
    const passing: InputGrades = { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [scalarGrade(advisory, 1)] };
    const failing: InputGrades = { input: input("b"), run: { output: null, recordPath: "" }, gatesPassed: false, grades: [scalarGrade(advisory, 1)] };
    expect(new Scorecard([passing]).gatesPassed()).toBe(true);
    expect(new Scorecard([passing, failing]).gatesPassed()).toBe(false);
  });

  it("an input with no grades scores 0", () => {
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [] },
    ];
    expect(new Scorecard(perInput).inputScores()).toEqual([0]);
  });
});
