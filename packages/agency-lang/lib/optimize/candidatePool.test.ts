import { describe, expect, it } from "vitest";

import { CandidatePool, type PoolCandidate } from "./candidatePool.js";
import { makeRng } from "./rng.js";

const cand = (id: string, scores: number[], objective: number): PoolCandidate<string> => ({
  value: id,
  inputScores: scores,
  objective,
});

describe("CandidatePool", () => {
  it("returns the best candidate by objective", () => {
    const pool = new CandidatePool([cand("a", [1, 0], 0.5), cand("b", [0.9, 0.9], 0.9)]);
    expect(pool.best().value).toBe("b");
  });

  it("samples a parent from the Pareto frontier", () => {
    const pool = new CandidatePool([cand("a", [1, 0], 0.5), cand("b", [0, 1], 0.5), cand("c", [0.1, 0.1], 0.1)]);
    const rng = makeRng(5);
    for (let i = 0; i < 30; i += 1) expect(["a", "b"]).toContain(pool.sampleParent(rng).value);
  });

  it("grows when a candidate is added", () => {
    const pool = new CandidatePool([cand("a", [1], 1)]);
    pool.add(cand("b", [0.5], 0.5));
    expect(pool.size()).toBe(2);
  });
});
