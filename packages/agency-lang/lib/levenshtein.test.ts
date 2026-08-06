import { describe, expect, it } from "vitest";
import { levenshtein } from "./levenshtein.js";

describe("levenshtein", () => {
  it("is zero for identical strings", () => {
    expect(levenshtein("gpt-4o-mini", "gpt-4o-mini")).toBe(0);
  });

  it("counts a single inserted character", () => {
    expect(levenshtein("gpt-4o-mini", "gpt-4o-minii")).toBe(1);
  });

  it("counts a substitution", () => {
    expect(levenshtein("cat", "cot")).toBe(1);
  });

  it("handles an empty string on either side", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  it("is symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(
      levenshtein("sitting", "kitten"),
    );
  });
});
