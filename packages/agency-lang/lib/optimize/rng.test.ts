import { describe, expect, it } from "vitest";

import { makeRng, sampleWithoutReplacement, weightedPick } from "./rng.js";

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42); const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("sampleWithoutReplacement returns k distinct items from the source", () => {
    const picked = sampleWithoutReplacement([1, 2, 3, 4, 5], 3, makeRng(1));
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(picked.every((x) => [1, 2, 3, 4, 5].includes(x))).toBe(true);
  });

  it("sampleWithoutReplacement returns all items when k exceeds the source size", () => {
    expect(sampleWithoutReplacement([1, 2], 5, makeRng(1)).sort()).toEqual([1, 2]);
  });

  it("weightedPick never selects a zero-weight item", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 50; i += 1) {
      const pick = weightedPick([{ item: "a", weight: 0 }, { item: "b", weight: 1 }], rng);
      expect(pick).toBe("b");
    }
  });
});
