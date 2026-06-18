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

  it("excludes gating graders from the objective", () => {
    const gate = new StubGrader({ mustPass: true });
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
    expect(new Scorecard(perInput).objective()).toBeCloseTo(0.5, 10);
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

  it("an input with no scalar contributions scores 0", () => {
    const gate = new StubGrader({ mustPass: true });
    const perInput: InputGrades[] = [
      { input: input("a"), run: { output: null, recordPath: "" }, gatesPassed: true, grades: [{ grader: gate, grade: { score: { kind: "binary", pass: true } } }] },
    ];
    expect(new Scorecard(perInput).inputScores()).toEqual([0]);
  });
});
