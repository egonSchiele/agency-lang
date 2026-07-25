import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { manyFunctions } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";

// Parse is isolated first: it dominates every downstream measurement, so a
// parser regression must not hide inside "compile" or "typecheck". Sizes are
// kept in a sane memory regime — parse degrades sharply past ~4000 functions
// (an 18s cliff at 8000), which reads as super-linear from GC/cache pressure
// rather than pure algorithmic cost. See the PR notes on parser scaling.
describe("parse scaling", () => {
  it("scales linearly in file size", () => {
    const big = parseAgency(manyFunctions(2000), {}, false);
    expect(big.success).toBe(true); // work-happened

    const build = (n: number) => {
      const src = manyFunctions(n);
      return () => parseAgency(src, {}, false);
    };
    expectPerf("parse:manyFunctions", growthFactor(build, 250, 2000), GROWTH_BOUND);
  });
});
