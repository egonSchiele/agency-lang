import { weightedPick, type Rng } from "./rng.js";

export type Scored<T> = { item: T; scores: number[] };

/** Candidates that achieve the best score on at least one input, with their win counts.
 *  GEPA's "best on ≥1 input" frontier — NOT full multi-objective dominance. */
export function paretoFrontier<T>(pool: Scored<T>[]): { item: T; wins: number }[] {
  if (pool.length === 0) return [];
  const inputCount = pool[0].scores.length;
  const best = Array.from({ length: inputCount }, (_unused, i) => Math.max(...pool.map((c) => c.scores[i])));
  return pool
    .map((c) => ({ item: c.item, wins: best.filter((b, i) => c.scores[i] >= b).length }))
    .filter((m) => m.wins > 0);
}

/** Sample a frontier member weighted by how many inputs it wins. */
export function sampleFrontier<T>(pool: Scored<T>[], rng: Rng): T {
  const members = paretoFrontier(pool);
  return weightedPick(members.map((m) => ({ item: m.item, weight: m.wins })), rng);
}
