import { describe, expect, it } from "vitest";

import { assertValidPairwiseResult } from "./util.js";

describe("assertValidPairwiseResult", () => {
  it("throws with the malformed winner value", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "FOO",
        confidence: "high",
        reasoning: "",
      }),
    ).toThrow(/FOO/);
  });

  it("throws with the malformed confidence value", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "A",
        confidence: "certain",
        reasoning: "",
      }),
    ).toThrow(/certain/);
  });

  it("accepts valid judge output", () => {
    expect(() =>
      assertValidPairwiseResult({
        winner: "tie",
        confidence: "medium",
        reasoning: "Both are similar.",
      }),
    ).not.toThrow();
  });
});
