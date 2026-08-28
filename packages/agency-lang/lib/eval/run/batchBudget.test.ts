import { describe, expect, it } from "vitest";
import { batchCostCapFromConfig, makeBatchBudget } from "./batchBudget.js";

describe("batchCostCapFromConfig", () => {
  it("has no default and honors eval.limits.maxBatchCostUsd", () => {
    expect(batchCostCapFromConfig({})).toBeUndefined();
    expect(batchCostCapFromConfig({ eval: { limits: { maxBatchCostUsd: 25 } } })).toBe(25);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        batchCostCapFromConfig({ eval: { limits: { maxBatchCostUsd: bad } } }),
      ).toBeUndefined();
    }
  });
});

describe("makeBatchBudget", () => {
  it("reports the crossing once and stays exhausted", () => {
    const budget = makeBatchBudget(5);
    expect(budget.add(3)).toBe(false);
    expect(budget.exhausted()).toBe(false);
    expect(budget.add(3)).toBe(true);
    expect(budget.exhausted()).toBe(true);
    expect(budget.add(1)).toBe(false);
    expect(budget.spentUsd()).toBe(7);
    expect(budget.exceededMessage()).toContain("$7.00 spent, cap $5.00");
  });

  it("never exhausts without a cap", () => {
    const budget = makeBatchBudget(undefined);
    expect(budget.add(1_000)).toBe(false);
    expect(budget.exhausted()).toBe(false);
    expect(budget.spentUsd()).toBe(1_000);
  });
});
