import { describe, it, expect } from "vitest";
import {
  InvocationUsageMeter,
  completionUsageDelta,
  paidCostDelta,
  normalizeUsageDelta,
  usageReconcileTolerance,
  unwrapServedInvocationOutcome,
  type ServedInvocationOutcome,
} from "./invocationUsage.js";

type Usage = ReturnType<InvocationUsageMeter["snapshot"]>["usage"];
function rowSumCost(usage: Usage) {
  const modelCost = Object.values(usage.models ?? {})
    .reduce((total, row) => total + row.pricedCost, 0);
  return modelCost + (usage.unattributed?.pricedCost ?? 0);
}
function reconciles(usage: Usage) {
  return Math.abs(rowSumCost(usage) - usage.pricedCost)
    <= usageReconcileTolerance(usage.pricedCost);
}

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
      models: {}, unattributed: { pricedCost: 0, inputTokens: 0, outputTokens: 0 },
      modelAttributionComplete: true,
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
    expect(completionUsageDelta({ cost: 0, inputTokens: 10, outputTokens: 2, model: "m" })).toEqual({
      pricedCost: 0, inputTokens: 10, outputTokens: 2, unknownCostCallCount: 0,
      attribution: { kind: "model", model: "m" },
    });
  });

  it("positive price is priced", () => {
    expect(completionUsageDelta({ cost: 0.5, inputTokens: 1, outputTokens: 1, model: "m" })).toEqual({
      pricedCost: 0.5, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0,
      attribution: { kind: "model", model: "m" },
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("%s price is unknown, contributes no cost, one unknown call", (_label, cost) => {
    expect(completionUsageDelta({ cost: cost as number, inputTokens: 4, outputTokens: 2, model: "m" })).toEqual({
      pricedCost: 0, inputTokens: 4, outputTokens: 2, unknownCostCallCount: 1,
      attribution: { kind: "model", model: "m" },
    });
  });

  it("absent or invalid tokens count as zero", () => {
    expect(completionUsageDelta({ cost: 0.1, inputTokens: undefined, outputTokens: null, model: "m" })).toMatchObject({
      inputTokens: 0, outputTokens: 0,
    });
    expect(completionUsageDelta({ cost: 0.1, inputTokens: -5, outputTokens: 1.5, model: "m" })).toMatchObject({
      inputTokens: 0, outputTokens: 0,
    });
  });
});

describe("paidCostDelta", () => {
  it("wraps a valid nonnegative amount as unattributed", () => {
    expect(paidCostDelta(0.25)).toEqual({
      pricedCost: 0.25, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0,
      attribution: { kind: "unattributed" },
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

describe("InvocationUsageMeter per-model breakdown", () => {
  it("files a priced completion under its model row and reconciles", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.1, inputTokens: 100, outputTokens: 20, model: "opus" }));
    const { usage } = meter.snapshot();
    expect(usage.models!["opus"]).toEqual({ pricedCost: 0.1, inputTokens: 100, outputTokens: 20 });
    expect(reconciles(usage)).toBe(true);
  });

  it("routes addCost spend to unattributed, not models", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(paidCostDelta(0.03));
    const { usage } = meter.snapshot();
    expect(usage.models).toEqual({});
    expect(usage.unattributed).toEqual({ pricedCost: 0.03, inputTokens: 0, outputTokens: 0 });
    expect(reconciles(usage)).toBe(true);
  });

  it("mixes a model row and unattributed", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.1, inputTokens: 1, outputTokens: 1, model: "opus" }));
    meter.merge(paidCostDelta(0.03));
    const { usage } = meter.snapshot();
    expect(usage.models!["opus"].pricedCost).toBeCloseTo(0.1);
    expect(usage.unattributed!.pricedCost).toBeCloseTo(0.03);
    expect(reconciles(usage)).toBe(true);
  });

  it("makes no row for a pure unknown-cost delta and keeps attribution complete", () => {
    const meter = new InvocationUsageMeter();
    meter.merge({ pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 1 });
    const { usage } = meter.snapshot();
    expect(usage.models).toEqual({});
    expect(usage.unattributed).toEqual({ pricedCost: 0, inputTokens: 0, outputTokens: 0 });
    expect(usage.pricingComplete).toBe(false);
    expect(usage.modelAttributionComplete).toBe(true);
  });

  it("treats __proto__ as a plain own key", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.01, inputTokens: 1, outputTokens: 1, model: "__proto__" }));
    expect(Object.prototype.hasOwnProperty.call(meter.snapshot().usage.models, "__proto__")).toBe(true);
    expect(({} as any).pricedCost).toBeUndefined();
  });

  it("aggregates repeated charges for one model into one row", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.01, inputTokens: 10, outputTokens: 2, model: "opus" }));
    meter.merge(completionUsageDelta({ cost: 0.02, inputTokens: 20, outputTokens: 4, model: "opus" }));
    expect(meter.snapshot().usage.models!["opus"]).toEqual({ pricedCost: 0.03, inputTokens: 30, outputTokens: 6 });
  });

  it("reconciles a regrouping-sensitive interleave within tolerance where === fails", () => {
    const meter = new InvocationUsageMeter();
    const sequence: [string, number][] = [
      ["alpha", 0.1], ["beta", 0.1], ["alpha", 0.1], ["beta", 0.1], ["alpha", 0.1], ["beta", 0.1], ["alpha", 0.1],
    ];
    for (const [model, cost] of sequence) {
      meter.merge(completionUsageDelta({ cost, inputTokens: 1, outputTokens: 1, model }));
    }
    const { usage } = meter.snapshot();
    const rowSum = usage.models!["alpha"].pricedCost + usage.models!["beta"].pricedCost;
    expect(rowSum).not.toBe(usage.pricedCost);                 // 0.7000000000000001 vs 0.7
    expect(Math.abs(rowSum - usage.pricedCost)).toBeLessThanOrEqual(usageReconcileTolerance(usage.pricedCost));
  });

  it("keeps a real model named 'unknown model' as an ordinary row", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.01, inputTokens: 1, outputTokens: 1, model: "unknown model" }));
    const { usage } = meter.snapshot();
    expect(usage.models!["unknown model"].pricedCost).toBeCloseTo(0.01);
    expect(usage.unattributed).toEqual({ pricedCost: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("returns independent copies from snapshot", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.1, inputTokens: 1, outputTokens: 1, model: "opus" }));
    const firstSnapshot = meter.snapshot().usage;
    firstSnapshot.models!["opus"].pricedCost = 999;
    firstSnapshot.models!["extra"] = { pricedCost: 5, inputTokens: 0, outputTokens: 0 };
    firstSnapshot.unattributed!.pricedCost = 999;

    const secondSnapshot = meter.snapshot().usage;
    expect(secondSnapshot.models!["opus"].pricedCost).toBeCloseTo(0.1);
    expect(secondSnapshot.models!["extra"]).toBeUndefined();
    expect(secondSnapshot.unattributed!.pricedCost).toBe(0);
  });

  it("flips modelAttributionComplete once, idempotently", () => {
    const meter = new InvocationUsageMeter();
    expect(meter.snapshot().usage.modelAttributionComplete).toBe(true);
    expect(meter.markModelAttributionIncomplete()).toBe(true);
    expect(meter.markModelAttributionIncomplete()).toBe(false);
    expect(meter.snapshot().usage.modelAttributionComplete).toBe(false);
  });

  it("fails reconciliation when a row is corrupted above tolerance (check has teeth)", () => {
    const meter = new InvocationUsageMeter();
    meter.merge(completionUsageDelta({ cost: 0.1, inputTokens: 1, outputTokens: 1, model: "opus" }));
    const { usage } = meter.snapshot();
    usage.models!["opus"].pricedCost -= 2 * usageReconcileTolerance(usage.pricedCost) + 0.001;
    expect(reconciles(usage)).toBe(false);
  });
});

describe("normalizeUsageDelta attribution", () => {
  it("preserves model and unattributed, drops malformed/absent to undefined", () => {
    const modelDelta = normalizeUsageDelta({
      pricedCost: 0.1, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0,
      attribution: { kind: "model", model: "opus" },
    });
    expect(modelDelta?.attribution).toEqual({ kind: "model", model: "opus" });

    const unattributedDelta = normalizeUsageDelta({
      pricedCost: 0.1, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0,
      attribution: { kind: "unattributed" },
    });
    expect(unattributedDelta?.attribution).toEqual({ kind: "unattributed" });

    const malformedAttributions = [undefined, null, 42, { kind: "model" }, { kind: "model", model: "" }, { kind: "nope" }];
    for (const malformedAttribution of malformedAttributions) {
      const normalized = normalizeUsageDelta({
        pricedCost: 0.1, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0,
        attribution: malformedAttribution,
      });
      expect(normalized?.attribution).toBeUndefined();
    }
  });
});
