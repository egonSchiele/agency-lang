import { describe, expect, it } from "vitest";

import { ContainsGrader, ExactMatchGrader, SimilarityGrader } from "./builtinGraders.js";
import type { GraderInput, Input, Json } from "./types.js";

const gi = (output: Json, metadata: Record<string, Json>): GraderInput => {
  const input: Input = { id: "i1", args: {}, metadata };
  return { input, run: { output, recordPath: "" } };
};

describe("ExactMatchGrader", () => {
  const grader = new ExactMatchGrader({ matchOn: ["metadata", "expected"] });

  it("passes when the agent output equals the referenced value", async () => {
    const grade = await grader.run(gi("New Delhi", { expected: "New Delhi" }));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("fails with feedback when the output differs", async () => {
    const grade = await grader.run(gi("Mumbai", { expected: "New Delhi" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toContain("New Delhi");
    expect(grade.feedback).toContain("Mumbai");
  });

  it("compares structured values deeply", async () => {
    const grade = await grader.run(gi({ a: [1, 2] } as Json, { expected: { a: [1, 2] } as Json }));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });
});

describe("ContainsGrader", () => {
  const grader = new ContainsGrader({ matchOn: ["metadata", "needle"] });

  it("passes when the output contains the needle", async () => {
    expect((await grader.run(gi("the capital is New Delhi today", { needle: "New Delhi" }))).score).toEqual({ kind: "binary", pass: true });
  });

  it("fails when the output does not contain the needle", async () => {
    expect((await grader.run(gi("the capital is Mumbai", { needle: "New Delhi" }))).score).toEqual({ kind: "binary", pass: false });
  });
});

describe("SimilarityGrader", () => {
  const grader = new SimilarityGrader({ matchOn: ["metadata", "expected"] });

  it("scores 1 for an exact match", async () => {
    expect((await grader.run(gi("hello", { expected: "hello" }))).score).toEqual({ kind: "scalar", value: 1 });
  });

  it("scores 0 against an empty-vs-nonempty comparison", async () => {
    expect((await grader.run(gi("", { expected: "hello" }))).score).toEqual({ kind: "scalar", value: 0 });
  });

  it("scores between 0 and 1 for a near match", async () => {
    const grade = await grader.run(gi("hella", { expected: "hello" }));
    if (grade.score.kind !== "scalar") throw new Error("expected scalar");
    expect(grade.score.value).toBeGreaterThan(0.5);
    expect(grade.score.value).toBeLessThan(1);
  });
});
