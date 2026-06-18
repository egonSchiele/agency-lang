export type Rng = () => number;   // returns a float in [0, 1)

/** mulberry32 — small, fast, deterministic PRNG. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleWithoutReplacement<T>(items: T[], k: number, rng: Rng): T[] {
  const pool = [...items];
  const out: T[] = [];
  const take = Math.min(k, pool.length);
  for (let i = 0; i < take; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

export function weightedPick<T>(weighted: { item: T; weight: number }[], rng: Rng): T {
  const total = weighted.reduce((sum, w) => sum + Math.max(0, w.weight), 0);
  if (total <= 0) throw new Error("weightedPick: no positive-weight items");
  let r = rng() * total;
  for (const w of weighted) {
    r -= Math.max(0, w.weight);
    if (r < 0) return w.item;
  }
  return weighted[weighted.length - 1].item;
}
