import { describe, it, expect } from "vitest";
import {
  InvocationUsageMeter,
  normalizeObservation,
  normalizeIpcUsageDelta,
  usageReconcileTolerance,
  unwrapServedInvocationOutcome,
  type NormalizedDelta,
  type ServedInvocationOutcome,
} from "./invocationUsage.js";

const MAX = Number.MAX_SAFE_INTEGER;
const fullCost = { inputCost: 0.1, outputCost: 0.2, cachedInputCost: 0.03, cacheCreationInputCost: 0.04, hostedToolsCost: 0.05, totalCost: 0.42, currency: "USD" };
const fullTokens = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5, cacheCreationInputTokens: 3, totalTokens: 128 };

describe("normalizeObservation — provider cost", () => {
  it("keeps each component and the authoritative total for a valid USD cost", () => {
    const d = normalizeObservation({ type: "provider", kind: "completion", reportedModel: "opus", cost: fullCost as any, tokens: fullTokens as any });
    expect(d.cost).toEqual(fullCost);
    expect(d.unknownCostCallCount).toBe(0);
    expect(d.attributionLost).toBe(false);
    expect(d.entry).toMatchObject({ kind: "completion", model: "opus" });
  });
  it("maps absent/negative/NaN/±Infinity components to 0 without touching the total", () => {
    const d = normalizeObservation({ type: "provider", kind: "completion", reportedModel: "m", cost: { totalCost: 0.42, currency: "USD", inputCost: -1, outputCost: Number.NaN, cachedInputCost: Number.POSITIVE_INFINITY, cacheCreationInputCost: Number.NEGATIVE_INFINITY } as any });
    expect(d.cost.totalCost).toBe(0.42);
    expect(d.cost.inputCost).toBe(0);
    expect(d.cost.outputCost).toBe(0);
    expect(d.cost.cachedInputCost).toBe(0);
    expect(d.cost.cacheCreationInputCost).toBe(0);
    expect(d.cost.hostedToolsCost).toBe(0);
  });
  it("treats an invalid or non-USD total as unpriced (all cost zero, +1 unknown) but keeps the entry+tokens", () => {
    const nonUsd = normalizeObservation({ type: "provider", kind: "completion", reportedModel: "m", cost: { ...fullCost, currency: "EUR" } as any, tokens: fullTokens as any });
    expect(nonUsd.cost).toEqual({ inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" });
    expect(nonUsd.unknownCostCallCount).toBe(1);
    expect(nonUsd.entry?.tokens.totalTokens).toBe(128);
    const noCost = normalizeObservation({ type: "provider", kind: "completion", reportedModel: "m" });
    expect(noCost.unknownCostCallCount).toBe(1);
    expect(noCost.cost.totalCost).toBe(0);
  });
  it("known-free (totalCost 0) is priced", () => {
    const d = normalizeObservation({ type: "provider", kind: "embedding", reportedModel: "e", cost: { totalCost: 0, currency: "USD" } as any });
    expect(d.unknownCostCallCount).toBe(0);
    expect(d.cost.totalCost).toBe(0);
  });
});

describe("normalizeObservation — tokens & model", () => {
  it("uses the provider totalTokens verbatim (cached-image not double-counted)", () => {
    const d = normalizeObservation({ type: "provider", kind: "image", reportedModel: "img", tokens: { inputTokens: 100, outputTokens: 0, cachedInputTokens: 30, totalTokens: 100 } as any });
    expect(d.tokens.totalTokens).toBe(100);
  });
  it("kind-specific fallback when totalTokens absent", () => {
    const comp = normalizeObservation({ type: "provider", kind: "completion", reportedModel: "c", tokens: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 5, cacheCreationInputTokens: 3 } as any });
    expect(comp.tokens.totalTokens).toBe(20);
    const img = normalizeObservation({ type: "provider", kind: "image", reportedModel: "i", tokens: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 5 } as any });
    expect(img.tokens.totalTokens).toBe(12);
  });
  it("present-malformed totalTokens falls back and degrades", () => {
    const d = normalizeObservation({ type: "provider", kind: "completion", reportedModel: "c", tokens: { inputTokens: 4, outputTokens: 2, totalTokens: -1 } as any });
    expect(d.tokens.totalTokens).toBe(6);
    expect(d.attributionLost).toBe(true);
  });
  it("resolves reported → configured → unknown model", () => {
    expect(normalizeObservation({ type: "provider", kind: "completion", reportedModel: "opus", configuredModel: "sonnet" }).entry?.model).toBe("opus");
    expect(normalizeObservation({ type: "provider", kind: "completion", reportedModel: "", configuredModel: "sonnet" }).entry?.model).toBe("sonnet");
    expect(normalizeObservation({ type: "provider", kind: "completion" }).entry?.model).toBe("unknown model");
  });
});

describe("normalizeObservation — manual & attempt", () => {
  it("manual → entry with model '' and totalCost=amount", () => {
    const d = normalizeObservation({ type: "manual", amount: 0.03 });
    expect(d.entry).toMatchObject({ kind: "manual", model: "" });
    expect(d.entry?.cost.totalCost).toBe(0.03);
    expect(d.cost.totalCost).toBe(0.03);
    expect(d.unknownCostCallCount).toBe(0);
  });
  it("attempt → no entry, +1 unknown, zero money", () => {
    const d = normalizeObservation({ type: "attempt", kind: "completion" });
    expect(d.entry).toBeUndefined();
    expect(d.unknownCostCallCount).toBe(1);
    expect(d.cost.totalCost).toBe(0);
  });
});

describe("InvocationUsageMeter", () => {
  it("keeps separate (kind, model) buckets in first-seen order and reconciles when complete", () => {
    const m = new InvocationUsageMeter();
    m.merge(normalizeObservation({ type: "provider", kind: "completion", reportedModel: "opus", cost: { totalCost: 0.1, currency: "USD" } as any }));
    m.merge(normalizeObservation({ type: "provider", kind: "embedding", reportedModel: "opus", cost: { totalCost: 0.2, currency: "USD" } as any }));
    m.merge(normalizeObservation({ type: "provider", kind: "completion", reportedModel: "opus", cost: { totalCost: 0.05, currency: "USD" } as any }));
    const { usage, usageComplete } = m.snapshot();
    expect(usageComplete).toBe(true);
    expect(usage.entries.map((e) => `${e.kind}:${e.model}`)).toEqual(["completion:opus", "embedding:opus"]);
    expect(usage.cost.totalCost).toBeCloseTo(0.35);
    const sum = usage.entries.reduce((a, e) => a + e.cost.totalCost, 0);
    expect(Math.abs(sum - usage.cost.totalCost)).toBeLessThanOrEqual(usageReconcileTolerance(usage.cost.totalCost));
  });
  it("snapshot returns deep copies (top-level + nested entry fields)", () => {
    const m = new InvocationUsageMeter();
    m.merge(normalizeObservation({ type: "provider", kind: "completion", reportedModel: "opus", cost: { totalCost: 0.1, currency: "USD" } as any, tokens: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } as any }));
    const a = m.snapshot();
    a.usage.cost.totalCost = 999;
    a.usage.tokens.inputTokens = 999;
    a.usage.entries[0].cost.totalCost = 999;
    a.usage.entries[0].tokens.inputTokens = 999;
    a.usage.entries.push({ kind: "manual", model: "", cost: {} as any, tokens: {} as any });
    const b = m.snapshot();
    expect(b.usage.cost.totalCost).toBeCloseTo(0.1);
    expect(b.usage.entries).toHaveLength(1);
    expect(b.usage.entries[0].cost.totalCost).toBeCloseTo(0.1);
    expect(b.usage.entries[0].tokens.inputTokens).toBe(5);
  });
  it("saturates a token overflow, marks incomplete, and merge reports only the first transition", () => {
    const m = new InvocationUsageMeter();
    const near: NormalizedDelta = { cost: { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" }, tokens: { inputTokens: MAX, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: MAX }, unknownCostCallCount: 0, attributionLost: false };
    const one: NormalizedDelta = { ...near, tokens: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 1 } };
    expect(m.merge(near)).toBe(false);
    expect(m.merge(one)).toBe(true);
    expect(m.merge(one)).toBe(false);
    const s = m.snapshot();
    expect(s.usageComplete).toBe(false);
    expect(s.usage.tokens.inputTokens).toBe(MAX);
  });
  it("markIncomplete is idempotent", () => {
    const m = new InvocationUsageMeter();
    expect(m.markIncomplete()).toBe(true);
    expect(m.markIncomplete()).toBe(false);
    expect(m.snapshot().usageComplete).toBe(false);
  });
});

describe("normalizeIpcUsageDelta — recover, never drop", () => {
  it("recovers a well-formed delta", () => {
    const d = normalizeIpcUsageDelta({ cost: fullCost, tokens: fullTokens, unknownCostCallCount: 0, entry: { kind: "completion", model: "opus", cost: fullCost, tokens: fullTokens } });
    expect(d?.cost.totalCost).toBe(0.42);
    expect(d?.entry?.model).toBe("opus");
    expect(d?.attributionLost).toBe(false);
  });
  it("invalid cost + valid tokens → keep tokens, +1 unknown, not a known-free zero", () => {
    const d = normalizeIpcUsageDelta({ cost: { totalCost: -1, currency: "USD" }, tokens: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 6 }, unknownCostCallCount: 0 });
    expect(d?.cost.totalCost).toBe(0);
    expect(d?.unknownCostCallCount).toBe(1);
    expect(d?.tokens.inputTokens).toBe(5);
  });
  it("unusable entry kind → preserve flat money, omit entry, degrade", () => {
    const d = normalizeIpcUsageDelta({ cost: fullCost, tokens: fullTokens, unknownCostCallCount: 0, entry: { kind: "nope", model: "x", cost: fullCost, tokens: fullTokens } });
    expect(d?.cost.totalCost).toBe(0.42);
    expect(d?.entry).toBeUndefined();
    expect(d?.attributionLost).toBe(true);
  });
  it("token-only entry (valid kind/model, invalid entry cost) survives with zero cost", () => {
    const d = normalizeIpcUsageDelta({ cost: fullCost, tokens: fullTokens, unknownCostCallCount: 0, entry: { kind: "completion", model: "opus", cost: { totalCost: -1, currency: "USD" }, tokens: fullTokens } });
    expect(d?.entry?.model).toBe("opus");
    expect(d?.entry?.cost.totalCost).toBe(0);
    expect(d?.entry?.tokens.totalTokens).toBe(128);
  });
  it("a non-object message is dropped", () => {
    expect(normalizeIpcUsageDelta(42)).toBeNull();
    expect(normalizeIpcUsageDelta(null)).toBeNull();
  });
});

describe("unwrapServedInvocationOutcome", () => {
  const snap = { usage: { cost: {} as any, tokens: {} as any, unknownCostCallCount: 0, pricingComplete: true, entries: [] }, usageComplete: true };
  it("returns / rethrows identity", () => {
    expect(unwrapServedInvocationOutcome({ status: "returned", value: "hi", ...snap } as ServedInvocationOutcome<string>)).toBe("hi");
    const frozen = Object.freeze(new Error("x"));
    try { unwrapServedInvocationOutcome({ status: "threw", error: frozen, ...snap }); expect.fail("throw"); } catch (e) { expect(e).toBe(frozen); }
  });
});
