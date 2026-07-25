import { describe, it, expect } from "vitest";
import { formatSource } from "../formatter.js";
import { manyFunctions } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";

// formatSource is the sync, pure core (the async `format` in commands.ts wraps
// it) — the cleaner measurement.
describe("fmt scaling", () => {
  it("scales linearly in file size", () => {
    expect(formatSource(manyFunctions(1200), {})).toBeTruthy(); // work-happened

    const build = (n: number) => {
      const src = manyFunctions(n);
      return () => formatSource(src, {});
    };
    expectPerf("fmt:manyFunctions", growthFactor(build, 150, 1200), GROWTH_BOUND);
  });
});
