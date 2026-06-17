import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIMIZER,
  getOptimizer,
  listOptimizers,
  registerOptimizer,
} from "./registry.js";
import type { OptimizeResult } from "./types.js";

describe("optimizer registry", () => {
  it("resolves the built-in greedy optimizer", () => {
    expect(getOptimizer("greedy").name).toBe("greedy");
  });

  it("defaults to greedy", () => {
    expect(DEFAULT_OPTIMIZER).toBe("greedy");
    expect(getOptimizer(DEFAULT_OPTIMIZER).name).toBe("greedy");
  });

  it("lists registered optimizers", () => {
    expect(listOptimizers()).toContain("greedy");
  });

  it("throws a helpful error naming the unknown optimizer and the available ones", () => {
    expect(() => getOptimizer("nope")).toThrow(/Unknown optimizer "nope".*greedy/);
  });

  it("registers and resolves a custom optimizer", () => {
    registerOptimizer("custom-test", () => ({
      name: "custom-test",
      optimize: async () => ({}) as OptimizeResult,
    }));
    expect(getOptimizer("custom-test").name).toBe("custom-test");
  });
});
