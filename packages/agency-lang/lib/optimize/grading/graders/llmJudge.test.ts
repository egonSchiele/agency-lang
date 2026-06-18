import { describe, expect, it } from "vitest";

import { AgencyRunner } from "../agencyRunner.js";
import { LlmJudge } from "./llmJudge.js";
import type { GraderInput, Input } from "../types.js";

const graderInput = (
  verdict: { score?: number; pass?: boolean; reasoning: string },
  metadata: Record<string, string> = { goal: "Return the capital" },
): GraderInput => {
  const input: Input = { id: "i1", args: {}, metadata };
  return { input, run: { output: "New Delhi", recordPath: "" }, runAgency: new AgencyRunner({}, async () => ({ data: verdict })) };
};

describe("LlmJudge", () => {
  it("maps a scalar verdict to a scalar grade with feedback", async () => {
    const judge = new LlmJudge({ name: "quality", agencyFile: "./quality.agency" });
    const grade = await judge.run(graderInput({ score: 0.9, reasoning: "good" }));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.9 });
    expect(grade.feedback).toBe("good");
  });

  it("maps a binary verdict to a binary grade", async () => {
    const judge = new LlmJudge({ name: "no-any", agencyFile: "./no-any.agency", binary: true });
    const grade = await judge.run(graderInput({ pass: false, reasoning: "uses any" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("uses any");
  });

  it("throws when no goal is present (an LLM judge needs something to judge against)", async () => {
    const judge = new LlmJudge({ name: "quality", agencyFile: "./quality.agency" });
    await expect(judge.run(graderInput({ score: 1, reasoning: "x" }, {}))).rejects.toThrow(/needs a goal/);
  });
});
