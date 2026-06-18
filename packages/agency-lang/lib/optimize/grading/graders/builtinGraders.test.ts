import { describe, expect, it } from "vitest";

import { AgencyRunner } from "../agencyRunner.js";
import { ContainsGrader, ExactMatchGrader, SimilarityGrader } from "./builtinGraders.js";
import type { GraderInput, Input, JSON } from "../types.js";

const stubRunner = new AgencyRunner({}, async () => ({ data: null }));
const graderInput = (output: JSON, metadata: Record<string, JSON>): GraderInput => {
  const input: Input = { id: "i1", args: {}, metadata };
  return { input, run: { output, recordPath: "" }, runAgency: stubRunner };
};

describe("ExactMatchGrader", () => {
  const grader = new ExactMatchGrader({ matchOn: ["metadata", "expected"] });

  it("passes when the agent output equals the referenced value", async () => {
    const grade = await grader.run(graderInput("New Delhi", { expected: "New Delhi" }));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("fails with feedback when the output differs", async () => {
    const grade = await grader.run(graderInput("Mumbai", { expected: "New Delhi" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toContain("New Delhi");
    expect(grade.feedback).toContain("Mumbai");
  });

  it("compares structured values deeply, regardless of key order", async () => {
    const grade = await grader.run(graderInput({ a: 1, b: [2, 3] } as JSON, { expected: { b: [2, 3], a: 1 } as JSON }));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("throws when matchOn does not resolve on the input", async () => {
    await expect(grader.run(graderInput("x", { other: "y" }))).rejects.toThrow(/matchOn .* did not resolve/);
  });
});

describe("ContainsGrader", () => {
  const grader = new ContainsGrader({ matchOn: ["metadata", "needle"] });

  it("passes when the output contains the needle", async () => {
    expect((await grader.run(graderInput("the capital is New Delhi today", { needle: "New Delhi" }))).score).toEqual({ kind: "binary", pass: true });
  });

  it("fails when the output does not contain the needle", async () => {
    expect((await grader.run(graderInput("the capital is Mumbai", { needle: "New Delhi" }))).score).toEqual({ kind: "binary", pass: false });
  });

  it("throws (rather than spuriously passing) when the needle is missing", async () => {
    await expect(grader.run(graderInput("anything", { other: "y" }))).rejects.toThrow(/matchOn .* did not resolve/);
  });
});

describe("SimilarityGrader", () => {
  const grader = new SimilarityGrader({ matchOn: ["metadata", "expected"] });

  it("scores 1 for an exact match", async () => {
    expect((await grader.run(graderInput("hello", { expected: "hello" }))).score).toEqual({ kind: "scalar", value: 1 });
  });

  it("scores 0 against an empty-vs-nonempty comparison", async () => {
    expect((await grader.run(graderInput("", { expected: "hello" }))).score).toEqual({ kind: "scalar", value: 0 });
  });

  it("scores between 0 and 1 for a near match", async () => {
    const grade = await grader.run(graderInput("hella", { expected: "hello" }));
    if (grade.score.kind !== "scalar") throw new Error("expected scalar");
    expect(grade.score.value).toBeGreaterThan(0.5);
    expect(grade.score.value).toBeLessThan(1);
  });
});
