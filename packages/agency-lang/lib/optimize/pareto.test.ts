import { describe, expect, it } from "vitest";

import { paretoFrontier, sampleFrontier } from "./pareto.js";
import { makeRng } from "./rng.js";

describe("paretoFrontier", () => {
  it("keeps candidates that are best on at least one input and excludes the dominated", () => {
    const pool = [
      { item: "A", scores: [0.9, 0.2, 0.5] },
      { item: "B", scores: [0.3, 0.8, 0.5] },
      { item: "C", scores: [0.4, 0.4, 0.4] },
    ];
    const members = paretoFrontier(pool);
    expect(members.map((m) => m.item).sort()).toEqual(["A", "B"]);
    // ties count as wins: A wins inputs 0 and 2; B wins inputs 1 and 2
    expect(members.find((m) => m.item === "A")!.wins).toBe(2);
    expect(members.find((m) => m.item === "B")!.wins).toBe(2);
  });

  it("sampleFrontier only ever returns a frontier member", () => {
    const pool = [
      { item: "A", scores: [1, 0] },
      { item: "B", scores: [0, 1] },
      { item: "C", scores: [0.1, 0.1] },
    ];
    const rng = makeRng(3);
    for (let i = 0; i < 50; i += 1) {
      expect(["A", "B"]).toContain(sampleFrontier(pool, rng));
    }
  });
});
