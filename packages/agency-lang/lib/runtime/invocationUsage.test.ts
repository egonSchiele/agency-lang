import { describe, it, expect } from "vitest";
import {
  InvocationUsageMeter,
  completionUsageDelta,
  paidCostDelta,
  normalizeUsageDelta,
  unwrapServedInvocationOutcome,
  type ServedInvocationOutcome,
} from "./invocationUsage.js";

describe("InvocationUsageMeter", () => {
  it("accumulates deltas and derives pricingComplete", () => {
    const m = new InvocationUsageMeter();
    m.merge({ pricedCost: 0.01, inputTokens: 100, outputTokens: 20, unknownCostCallCount: 0 });
    m.merge({ pricedCost: 0.02, inputTokens: 5, outputTokens: 1, unknownCostCallCount: 0 });
    const s = m.snapshot();
    expect(s.usage.pricedCost).toBeCloseTo(0.03);
    expect(s.usage.inputTokens).toBe(105);
    expect(s.usage.outputTokens).toBe(21);
    expect(s.usage.unknownCostCallCount).toBe(0);
    expect(s.usage.pricingComplete).toBe(true);
    expect(s.usageComplete).toBe(true);
  });

  it("a fresh meter is complete and zeroed", () => {
    const s = new InvocationUsageMeter().snapshot();
    expect(s.usage).toEqual({
      pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0, pricingComplete: true,
    });
    expect(s.usageComplete).toBe(true);
  });

  it("any unknown-cost call flips pricingComplete false", () => {
    const m = new InvocationUsageMeter();
    m.merge({ pricedCost: 0, inputTokens: 3, outputTokens: 1, unknownCostCallCount: 1 });
    expect(m.snapshot().usage.pricingComplete).toBe(false);
  });

  it("markIncomplete is permanent and reports only the first transition", () => {
    const m = new InvocationUsageMeter();
    expect(m.markIncomplete()).toBe(true);
    expect(m.markIncomplete()).toBe(false);
    expect(m.snapshot().usageComplete).toBe(false);
  });
});

describe("completionUsageDelta", () => {
  it("finite zero is a known free price (not unknown)", () => {
    expect(completionUsageDelta({ cost: 0, inputTokens: 10, outputTokens: 2 })).toEqual({
      pricedCost: 0, inputTokens: 10, outputTokens: 2, unknownCostCallCount: 0,
    });
  });

  it("positive price is priced", () => {
    expect(completionUsageDelta({ cost: 0.5, inputTokens: 1, outputTokens: 1 })).toEqual({
      pricedCost: 0.5, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0,
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("%s price is unknown, contributes no cost, one unknown call", (_label, cost) => {
    expect(completionUsageDelta({ cost: cost as number, inputTokens: 4, outputTokens: 2 })).toEqual({
      pricedCost: 0, inputTokens: 4, outputTokens: 2, unknownCostCallCount: 1,
    });
  });

  it("absent or invalid tokens count as zero", () => {
    expect(completionUsageDelta({ cost: 0.1, inputTokens: undefined, outputTokens: null })).toMatchObject({
      inputTokens: 0, outputTokens: 0,
    });
    expect(completionUsageDelta({ cost: 0.1, inputTokens: -5, outputTokens: 1.5 })).toMatchObject({
      inputTokens: 0, outputTokens: 0,
    });
  });
});

describe("paidCostDelta", () => {
  it("wraps a valid nonnegative amount", () => {
    expect(paidCostDelta(0.25)).toEqual({
      pricedCost: 0.25, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0,
    });
    expect(paidCostDelta(0)).toMatchObject({ pricedCost: 0 });
  });

  it.each([-1, NaN, Infinity])("throws on invalid amount %s (never silently zero)", (amount) => {
    expect(() => paidCostDelta(amount)).toThrow();
  });
});

describe("normalizeUsageDelta", () => {
  it("returns null for a non-object", () => {
    expect(normalizeUsageDelta(null)).toBeNull();
    expect(normalizeUsageDelta(42)).toBeNull();
  });

  it("passes through a valid delta", () => {
    expect(normalizeUsageDelta({ pricedCost: 0.3, inputTokens: 9, outputTokens: 3, unknownCostCallCount: 1 })).toEqual({
      pricedCost: 0.3, inputTokens: 9, outputTokens: 3, unknownCostCallCount: 1,
    });
  });

  it("an invalid cost becomes one unknown-cost call while valid fields survive", () => {
    expect(normalizeUsageDelta({ pricedCost: -5, inputTokens: 9, outputTokens: 3, unknownCostCallCount: 0 })).toEqual({
      pricedCost: 0, inputTokens: 9, outputTokens: 3, unknownCostCallCount: 1,
    });
  });

  it("invalid token/count fields become zero", () => {
    expect(normalizeUsageDelta({ pricedCost: 0.1, inputTokens: "x", outputTokens: -2, unknownCostCallCount: 1.5 })).toEqual({
      pricedCost: 0.1, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0,
    });
  });
});

describe("unwrapServedInvocationOutcome", () => {
  it("returns the value for a returned outcome", () => {
    const o: ServedInvocationOutcome<string> = {
      status: "returned", value: "hi",
      usage: { pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0, pricingComplete: true },
      usageComplete: true,
    };
    expect(unwrapServedInvocationOutcome(o)).toBe("hi");
  });

  it("rethrows the identical error (string, frozen object)", () => {
    const snap = {
      usage: { pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0, pricingComplete: true },
      usageComplete: true,
    };
    expect(() => unwrapServedInvocationOutcome({ status: "threw", error: "boom", ...snap })).toThrow("boom");
    const frozen = Object.freeze(new Error("frozen"));
    try {
      unwrapServedInvocationOutcome({ status: "threw", error: frozen, ...snap });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe(frozen);
    }
  });
});
