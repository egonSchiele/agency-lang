import { sampleFrontier, type Scored } from "./pareto.js";
import type { Rng } from "./rng.js";

/** A pool member: a payload plus the score vector/objective the frontier reasons over.
 *  In GEPA, `value` is the full Candidate (ws + scorecard + files), so reflection can
 *  reach the parent's per-input grades and traces. */
export type PoolCandidate<T> = { value: T; inputScores: number[]; objective: number };

export class CandidatePool<T> {
  constructor(private readonly candidates: PoolCandidate<T>[]) {}

  add(candidate: PoolCandidate<T>): void {
    this.candidates.push(candidate);
  }

  size(): number {
    return this.candidates.length;
  }

  best(): PoolCandidate<T> {
    return this.candidates.reduce((top, c) => (c.objective > top.objective ? c : top));
  }

  sampleParent(rng: Rng): PoolCandidate<T> {
    const scored: Scored<PoolCandidate<T>>[] = this.candidates.map((c) => ({ item: c, scores: c.inputScores }));
    return sampleFrontier(scored, rng);
  }
}
