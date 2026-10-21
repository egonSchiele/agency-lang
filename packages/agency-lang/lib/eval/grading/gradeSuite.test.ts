import { describe, expect, it } from "vitest";

import { grader } from "./functionGrader.js";
import { LlmJudge } from "./graders/llmJudge.js";
import { scoreDrafts } from "./gradeSuite.js";
import { Scorecard, type InputGrades } from "./scorecard.js";

const pass = { score: { kind: "binary" as const, pass: true } };

function entry(goal: string | undefined, graders: InputGrades["grades"]): InputGrades {
  const test = goal === undefined ? { id: "a", input: "t" } : { id: "a", input: "t", goal };
  return {
    test,
    run: { traceId: "trace-1" } as InputGrades["run"],
    grades: graders,
    gatesPassed: true,
  };
}

describe("scoreDrafts", () => {
  it("records the goal a judge scored against, and nothing for other graders", () => {
    const judge = new LlmJudge({ name: "goal" });
    const fn = grader(() => 1, { name: "len" });
    const card = new Scorecard([
      entry("be nice", [
        { grader: judge, grade: pass },
        { grader: fn, grade: pass },
      ]),
    ]);

    const drafts = scoreDrafts(card);

    expect(drafts.find((d) => d.name === "goal")?.goal).toBe("be nice");
    expect(drafts.find((d) => d.name === "len")).not.toHaveProperty("goal");
  });

  it("copies a grade's points onto the draft, and leaves the field absent otherwise", () => {
    const checklist = grader(() => 1, { name: "checklist" });
    const plain = grader(() => 1, { name: "plain" });
    const points = [{ point: "one package", pass: true, evidence: "one bin" }];
    const drafts = scoreDrafts(
      new Scorecard([
        entry(undefined, [
          { grader: checklist, grade: { ...pass, points } },
          { grader: plain, grade: pass },
        ]),
      ]),
    );
    expect(drafts.find((d) => d.name === "checklist")?.points).toEqual(points);
    expect(drafts.find((d) => d.name === "plain")).not.toHaveProperty("points");
  });

  it("records no goal when the test carries none", () => {
    const judge = new LlmJudge({ name: "goal" });
    const drafts = scoreDrafts(new Scorecard([entry(undefined, [{ grader: judge, grade: pass }])]));
    expect(drafts[0]).not.toHaveProperty("goal");
  });
});
