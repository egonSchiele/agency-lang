import { describe, expect, it } from "vitest";
import { benchmarkFromSuite } from "./benchmark.js";

describe("benchmarkFromSuite", () => {
  it.each([
    ["/home/me/evals/plan-easy", "plan-easy"],
    ["/home/me/evals/plan-easy/", "plan-easy"],
    ["/home/me/evals/plan-easy.json", "plan-easy"],
    ["github.com/acme/evals//suites/plan-easy?ref=abc123", "plan-easy"],
    ["github.com/acme/plan-suites?ref=abc123", "plan-suites"],
    ["https://github.com/acme/plan-suites.git", "plan-suites"],
    ["inline:--input", null],
    ["unspecified", null],
    ["optimize", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("derives the benchmark from the suite source %s", (source, expected) => {
    expect(benchmarkFromSuite(source)).toBe(expected);
  });
});
