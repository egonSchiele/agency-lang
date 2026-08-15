import { describe, it, expect } from "vitest";
import { projectSpendSchema, accountSpendRowSchema, toSpendQuery } from "./spendTypes.js";

const usd = {
  inputCost: 0.3,
  outputCost: 0.2,
  cachedInputCost: 0,
  cacheCreationInputCost: 0,
  hostedToolsCost: 0,
  totalCost: 0.5,
  currency: "USD" as const,
};
const tok = {
  inputTokens: 10,
  outputTokens: 2,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 12,
};
const zeroUsd = {
  inputCost: 0,
  outputCost: 0,
  cachedInputCost: 0,
  cacheCreationInputCost: 0,
  hostedToolsCost: 0,
  totalCost: 0,
  currency: "USD" as const,
};
const zeroTok = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 0,
};
const valid = {
  cost: usd,
  tokens: tok,
  invocationCount: 3,
  unpricedCallCount: 0,
  pricingComplete: true,
  usageComplete: true,
  breakdown: [{ model: "opus", kind: "completion" as const, cost: usd, tokens: tok }],
  breakdownTruncated: false,
  otherSpend: { cost: zeroUsd, tokens: zeroTok },
};
const empty = {
  cost: zeroUsd,
  tokens: zeroTok,
  invocationCount: 0,
  unpricedCallCount: 0,
  pricingComplete: true,
  usageComplete: true,
  breakdown: [],
  breakdownTruncated: false,
  otherSpend: { cost: zeroUsd, tokens: zeroTok },
};

describe("projectSpendSchema", () => {
  it("accepts a valid spend and the complete empty identity", () => {
    expect(projectSpendSchema.parse(valid)).toEqual(valid);
    expect(projectSpendSchema.parse(empty)).toEqual(empty);
  });

  it("rejects non-finite/negative cost, non-USD currency, unsafe/negative counts", () => {
    expect(() => projectSpendSchema.parse({ ...valid, cost: { ...usd, totalCost: -1 } })).toThrow();
    expect(() =>
      projectSpendSchema.parse({ ...valid, cost: { ...usd, totalCost: Number.NaN } }),
    ).toThrow();
    expect(() =>
      projectSpendSchema.parse({ ...valid, cost: { ...usd, inputCost: Number.POSITIVE_INFINITY } }),
    ).toThrow();
    expect(() =>
      projectSpendSchema.parse({ ...valid, cost: { ...usd, currency: "EUR" } }),
    ).toThrow();
    expect(() =>
      projectSpendSchema.parse({ ...valid, tokens: { ...tok, inputTokens: -1 } }),
    ).toThrow();
    expect(() =>
      projectSpendSchema.parse({ ...valid, tokens: { ...tok, outputTokens: 2 ** 53 } }),
    ).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, invocationCount: 2 ** 53 })).toThrow();
  });

  it("enforces pricingComplete === (unpricedCallCount === 0)", () => {
    expect(() =>
      projectSpendSchema.parse({ ...valid, unpricedCallCount: 1, pricingComplete: true }),
    ).toThrow();
    expect(() =>
      projectSpendSchema.parse({ ...valid, unpricedCallCount: 0, pricingComplete: false }),
    ).toThrow();
    expect(
      projectSpendSchema.parse({ ...valid, unpricedCallCount: 1, pricingComplete: false })
        .pricingComplete,
    ).toBe(false);
  });

  it("requires breakdownTruncated and otherSpend, and parses a truncated spend", () => {
    const { breakdownTruncated: _bt, ...noTruncated } = valid;
    expect(() => projectSpendSchema.parse(noTruncated)).toThrow();
    const { otherSpend: _os, ...noOther } = valid;
    expect(() => projectSpendSchema.parse(noOther)).toThrow();
    const parsed = projectSpendSchema.parse({
      ...valid,
      breakdownTruncated: true,
      otherSpend: { cost: usd, tokens: tok },
    });
    expect(parsed.breakdownTruncated).toBe(true);
    expect(parsed.otherSpend.cost.totalCost).toBe(0.5);
  });

  it("requires otherSpend to be zero when breakdownTruncated is false", () => {
    // non-zero tail without truncation → rejected
    expect(() =>
      projectSpendSchema.parse({
        ...valid,
        breakdownTruncated: false,
        otherSpend: { cost: usd, tokens: tok },
      }),
    ).toThrow();
    // zero tail without truncation → accepted (the valid fixture already is this)
    expect(projectSpendSchema.parse(valid).breakdownTruncated).toBe(false);
    // a truncated response may carry a zero tail too (omitted groups were free)
    expect(
      projectSpendSchema.parse({ ...valid, breakdownTruncated: true }).breakdownTruncated,
    ).toBe(true);
  });

  it("accepts the new transcription and speech kinds, still rejects an unknown kind", () => {
    expect(
      projectSpendSchema.parse({
        ...valid,
        breakdown: [{ model: "whisper-1", kind: "transcription", cost: usd, tokens: tok }],
      }).breakdown[0].kind,
    ).toBe("transcription");
    expect(
      projectSpendSchema.parse({
        ...valid,
        breakdown: [{ model: "tts-1", kind: "speech", cost: usd, tokens: tok }],
      }).breakdown[0].kind,
    ).toBe("speech");
    expect(() =>
      projectSpendSchema.parse({
        ...valid,
        breakdown: [{ model: "x", kind: "telepathy", cost: usd, tokens: tok }],
      }),
    ).toThrow();
  });

  it("rejects extra fields and a mismatched model sentinel", () => {
    expect(() => projectSpendSchema.parse({ ...valid, surprise: 1 })).toThrow();
    // manual rows must use model "" and provider rows a non-empty model.
    expect(() =>
      projectSpendSchema.parse({
        ...valid,
        breakdown: [{ model: "x", kind: "manual", cost: usd, tokens: tok }],
      }),
    ).toThrow();
    expect(() =>
      projectSpendSchema.parse({
        ...valid,
        breakdown: [{ model: "", kind: "completion", cost: usd, tokens: tok }],
      }),
    ).toThrow();
    expect(
      projectSpendSchema.parse({
        ...valid,
        breakdown: [{ model: "", kind: "manual", cost: usd, tokens: tok }],
      }).breakdown[0].kind,
    ).toBe("manual");
  });
});

describe("accountSpendRowSchema", () => {
  it("accepts null and ISO deletedAt, rejects junk", () => {
    expect(
      accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: null, spend: valid }).deletedAt,
    ).toBeNull();
    expect(
      accountSpendRowSchema.parse({
        projectSlug: "p",
        deletedAt: "2026-08-01T00:00:00.000Z",
        spend: valid,
      }).deletedAt,
    ).toBe("2026-08-01T00:00:00.000Z");
    expect(() =>
      accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: "nope", spend: valid }),
    ).toThrow();
  });

  it("accepts a zero-event deleted project row", () => {
    const row = accountSpendRowSchema.parse({
      projectSlug: "gone",
      deletedAt: "2026-08-01T00:00:00.000Z",
      spend: empty,
    });
    expect(row.spend.invocationCount).toBe(0);
  });
});

describe("toSpendQuery", () => {
  it("omits null bounds, serializes present ones as decimals", () => {
    expect(toSpendQuery({ from: null, to: null })).toEqual({});
    expect(toSpendQuery({ from: 1000, to: null })).toEqual({ from: "1000" });
    expect(toSpendQuery({ from: 1000, to: 2000 })).toEqual({ from: "1000", to: "2000" });
  });
});
