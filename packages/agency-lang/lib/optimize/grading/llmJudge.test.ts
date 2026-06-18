import { describe, expect, it } from "vitest";

import { AgencyRunner } from "./agencyRunner.js";
import { LlmJudge } from "./llmJudge.js";
import type { GraderInput, Input } from "./types.js";

const gi = (verdict: { score?: number; pass?: boolean; reasoning: string }): GraderInput => {
  const input: Input = { id: "i1", args: {}, metadata: { goal: "Return the capital" } };
  return { input, run: { output: "New Delhi", recordPath: "" }, runAgency: new AgencyRunner({}, async () => ({ data: verdict })) };
};

describe("LlmJudge", () => {
  it("maps a scalar verdict to a scalar grade with feedback", async () => {
    const judge = new LlmJudge({ name: "quality", agencyFile: "./quality.agency" });
    const grade = await judge.run(gi({ score: 0.9, reasoning: "good" }));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.9 });
    expect(grade.feedback).toBe("good");
  });

  it("maps a binary verdict to a binary grade", async () => {
    const judge = new LlmJudge({ name: "no-any", agencyFile: "./no-any.agency", binary: true });
    const grade = await judge.run(gi({ pass: false, reasoning: "uses any" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("uses any");
  });
});
