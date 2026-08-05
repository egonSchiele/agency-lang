import { describe, it, expect } from "vitest";
import { projectSpendSchema, accountSpendRowSchema, toSpendQuery } from "./spendTypes.js";

const valid = { pricedCost: 0.5, inputTokens: 10, outputTokens: 2, invocationCount: 3, unpricedCallCount: 0, pricingComplete: true, usageComplete: true };

describe("projectSpendSchema", () => {
  it("accepts a valid spend", () => { expect(projectSpendSchema.parse(valid)).toEqual(valid); });
  it("rejects non-finite/negative cost, unsafe/negative counts, contradictory completeness", () => {
    expect(() => projectSpendSchema.parse({ ...valid, pricedCost: -1 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, pricedCost: Number.NaN })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, pricedCost: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, inputTokens: -1 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, outputTokens: 2 ** 53 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, invocationCount: 2 ** 53 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, unpricedCallCount: 1, pricingComplete: true })).toThrow();
  });
});

describe("accountSpendRowSchema", () => {
  it("accepts null and ISO deletedAt, rejects junk", () => {
    expect(accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: null, spend: valid }).deletedAt).toBeNull();
    expect(accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: "2026-08-01T00:00:00.000Z", spend: valid }).deletedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(() => accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: "nope", spend: valid })).toThrow();
  });
});

describe("toSpendQuery", () => {
  it("omits null bounds, serializes present ones as decimals", () => {
    expect(toSpendQuery({ from: null, to: null })).toEqual({});
    expect(toSpendQuery({ from: 1000, to: null })).toEqual({ from: "1000" });
    expect(toSpendQuery({ from: 1000, to: 2000 })).toEqual({ from: "1000", to: "2000" });
  });
});
