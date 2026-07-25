import { describe, it, expect } from "vitest";
import { measureMs, growthFactor, GROWTH_BOUND } from "./harness.js";

// The timing-dependent harness meta-tests. They live in the serialized perf
// suite (not the parallel default unit run) so CPU contention can't flake the
// `< GROWTH_BOUND` assertion into a merge-blocking failure. Closures are sized
// so a single call is several ms — well above timing noise — and use pure
// arithmetic loops (no large arrays) to stay memory-cheap at 8x sizes.

function linearWork(n: number): () => number {
  return () => {
    let s = 0;
    for (let i = 0; i < n; i++) s = (s + i * 2654435761) >>> 0;
    return s;
  };
}

function quadraticWork(n: number): () => number {
  return () => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) s = (s + (i ^ j)) >>> 0;
    }
    return s;
  };
}

describe("perf harness timing (serialized)", () => {
  it("measureMs returns a positive, roughly stable time", () => {
    const fn = linearWork(4_000_000);
    const a = measureMs(fn);
    const b = measureMs(fn);
    expect(a).toBeGreaterThan(0);
    expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(5);
  });

  it("canary: a quadratic algorithm's growth factor is well above the bound", () => {
    // Normalized quadratic ≈ 8 at an 8x step — huge margin over the bound.
    const factor = growthFactor(quadraticWork, 700, 5600);
    expect(factor).toBeGreaterThan(GROWTH_BOUND * 1.5);
  });

  it("self-consistency: a linear algorithm's growth factor is below the bound", () => {
    // The test the old un-normalized (bound == step) design would have failed on
    // correct code: a raw ratio of ~8 is not < 8. Normalization makes it ~1.
    const factor = growthFactor(linearWork, 4_000_000, 32_000_000);
    expect(factor).toBeLessThan(GROWTH_BOUND);
  });
});
