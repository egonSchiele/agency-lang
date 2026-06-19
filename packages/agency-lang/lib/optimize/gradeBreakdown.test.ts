import { describe, expect, it } from "vitest";
import { Scorecard } from "./grading/scorecard.js";
import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput } from "./grading/types.js";
import { breakdown } from "./gradeBreakdown.js";

class Fixed extends BaseGrader {
  protected readonly defaultName = "fixed";
  constructor(private g: Grade, name: string) { super({ name }); }
  protected _run(_i: GraderInput): Promise<Grade> { return Promise.resolve(this.g); }
}

describe("breakdown", () => {
  it("renders per-input output and each grader's score + feedback", () => {
    const grade: Grade = { score: { kind: "scalar", value: 0.2 }, feedback: "off-topic" };
    const sc = new Scorecard([{
      input: { id: "brazil", args: {} },
      run: { output: "area is 8.5M km²", recordPath: "" },
      gatesPassed: true,
      grades: [{ grader: new Fixed(grade, "goal"), grade }],
    }]);
    expect(breakdown(sc)).toEqual([{
      inputId: "brazil",
      output: "area is 8.5M km²",
      objective: 0.2,
      gatesPassed: true,
      grades: [{ grader: "goal", kind: "scalar", value: 0.2, feedback: "off-topic" }],
    }]);
  });
});
