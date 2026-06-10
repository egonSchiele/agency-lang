import { describe, expect, it } from "vitest";

import { assertValidPairwiseResult } from "./util.js";

describe("assertValidPairwiseResult", () => {
  it("throws with the malformed winner value", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "FOO",
        confidence: 87,
        reasoning: "",
      }),
    ).toThrow(/FOO/);
  });

  it("throws with the malformed confidence value", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "A",
        confidence: 101,
        reasoning: "",
      }),
    ).toThrow(/101/);
  });

  it("throws with a non-integer confidence value", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "A",
        confidence: 42.5,
        reasoning: "",
      }),
    ).toThrow(/42.5/);
  });

  it("accepts valid judge output", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "tie",
        confidence: 50,
        reasoning: "Both are similar.",
      }),
    ).not.toThrow();
  });
});
