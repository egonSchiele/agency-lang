import { describe, expect, it } from "vitest";

import { aggregateGrades } from "./aggregate.js";
import type { Grade } from "./types.js";

const scalar = (value: number, feedback?: string): Grade => ({ score: { kind: "scalar", value }, feedback });
const binary = (pass: boolean, feedback?: string): Grade => ({ score: { kind: "binary", pass }, feedback });

describe("aggregateGrades", () => {
  it("averages scalar trials", () => {
    const result = aggregateGrades([scalar(0.2), scalar(0.4), scalar(0.6)], "all");
    expect(result.score).toEqual({ kind: "scalar", value: 0.4 });
  });

  it("binary 'all' passes only when every trial passes", () => {
    expect(aggregateGrades([binary(true), binary(true)], "all").score).toEqual({ kind: "binary", pass: true });
    expect(aggregateGrades([binary(true), binary(false)], "all").score).toEqual({ kind: "binary", pass: false });
  });

  it("binary 'any' passes when at least one trial passes", () => {
    expect(aggregateGrades([binary(false), binary(true)], "any").score).toEqual({ kind: "binary", pass: true });
    expect(aggregateGrades([binary(false), binary(false)], "any").score).toEqual({ kind: "binary", pass: false });
  });

  it("concatenates non-empty feedback across trials", () => {
    const result = aggregateGrades([scalar(1, "good"), scalar(0, "bad"), scalar(0.5)], "all");
    expect(result.feedback).toBe("good\nbad");
  });

  it("omits feedback entirely when no trial provided any", () => {
    expect(aggregateGrades([scalar(1), scalar(0)], "all").feedback).toBeUndefined();
  });

  it("returns the single trial unchanged for samples=1", () => {
    expect(aggregateGrades([binary(true, "ok")], "all")).toEqual(binary(true, "ok"));
  });
});
