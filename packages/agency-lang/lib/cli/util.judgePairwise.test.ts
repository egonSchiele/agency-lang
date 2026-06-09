import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { assertValidPairwiseResult } from "./util.js";

const agentsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../agents/judge",
);

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

  it("keeps the Agency judge schema aligned with validated pairwise values", () => {
    const source = fs.readFileSync(
      path.join(agentsDir, "pairwise.agency"),
      "utf-8",
    );

    expect(source).toContain('type PairwiseWinner = "A" | "B" | "tie"');
    expect(source).toContain(
      'type PairwiseConfidence = "low" | "medium" | "high"',
    );
    expect(source).toContain("confidence must be exactly one of");
  });
});
