import { describe, expect, it } from "vitest";

import type { BaseOptimizerConfig } from "./optimizer.js";
import {
  DEFAULT_OPTIMIZER,
  getOptimizer,
  listOptimizers,
  registerOptimizer,
} from "./registry.js";
import type { OptimizeResult } from "./types.js";

const config: BaseOptimizerConfig = { graders: [], iterations: 1, config: {}, runsDir: ".", runId: "r" };

describe("optimizer registry", () => {
  it("resolves the built-in greedy optimizer", () => {
    expect(getOptimizer("greedy", config).name).toBe("greedy");
  });

  it("defaults to greedy", () => {
    expect(DEFAULT_OPTIMIZER).toBe("greedy");
    expect(getOptimizer(DEFAULT_OPTIMIZER, config).name).toBe("greedy");
  });

  it("lists registered optimizers", () => {
    expect(listOptimizers()).toContain("greedy");
  });

  it("throws a helpful error naming the unknown optimizer and the available ones", () => {
    expect(() => getOptimizer("nope", config)).toThrow(/Unknown optimizer "nope".*greedy/);
  });

  it("registers and resolves a custom optimizer", () => {
    registerOptimizer("custom-test", () => ({
      name: "custom-test",
      optimize: async () => ({}) as OptimizeResult,
    }));
    expect(getOptimizer("custom-test", config).name).toBe("custom-test");
  });

  it("treats reserved object keys as unknown optimizers, not prototype lookups", () => {
    for (const reserved of ["__proto__", "constructor", "toString"]) {
      expect(() => getOptimizer(reserved, config)).toThrow(/Unknown optimizer/);
    }
  });
});
