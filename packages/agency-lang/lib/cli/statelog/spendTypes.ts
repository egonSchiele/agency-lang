// The statelog spend wire types — the single source of truth for the shape the
// per-project and account spend endpoints return, and the query serializer both
// clients share. The Zod schemas own the invariants; the TypeScript types are
// inferred from them so a hand-written type cannot drift from its runtime
// validator. Values are the camelCase full cost/token breakdown statelog emits
// (there is no snake-case transform for spend).

import { z } from "zod";

const nonNegativeSafeInt = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a safe integer");
const nonNegativeFinite = z.number().finite().nonnegative();

/** The authoritative money breakdown. Every component is finite and nonnegative;
 *  `totalCost` is authoritative (never derived from the components); currency is
 *  USD only. No extra fields are accepted. */
export const costBreakdownSchema = z
  .object({
    inputCost: nonNegativeFinite,
    outputCost: nonNegativeFinite,
    cachedInputCost: nonNegativeFinite,
    cacheCreationInputCost: nonNegativeFinite,
    hostedToolsCost: nonNegativeFinite,
    totalCost: nonNegativeFinite,
    currency: z.literal("USD"),
  })
  .strict();
export type CostBreakdown = z.infer<typeof costBreakdownSchema>;

/** The token breakdown. Every count is a nonnegative safe integer; `totalTokens`
 *  is authoritative. No extra fields are accepted. */
export const tokenBreakdownSchema = z
  .object({
    inputTokens: nonNegativeSafeInt,
    outputTokens: nonNegativeSafeInt,
    cachedInputTokens: nonNegativeSafeInt,
    cacheCreationInputTokens: nonNegativeSafeInt,
    totalTokens: nonNegativeSafeInt,
  })
  .strict();
export type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;

export const usageKindSchema = z.enum(["completion", "embedding", "image", "manual"]);
export type UsageKind = z.infer<typeof usageKindSchema>;

/** One `(model, kind)` attribution row. The model sentinel `""` marks manual
 *  charges (`addCost`); provider kinds always carry a non-empty model. */
export const modelKindSpendSchema = z
  .object({
    model: z.string(),
    kind: usageKindSchema,
    cost: costBreakdownSchema,
    tokens: tokenBreakdownSchema,
  })
  .strict()
  .refine(
    (row) => (row.kind === "manual" ? row.model === "" : row.model.length > 0),
    "manual rows use model '' and provider rows use a non-empty model",
  );
export type ModelKindSpend = z.infer<typeof modelKindSpendSchema>;

export const projectSpendSchema = z
  .object({
    cost: costBreakdownSchema,
    tokens: tokenBreakdownSchema,
    invocationCount: nonNegativeSafeInt,
    unpricedCallCount: nonNegativeSafeInt,
    pricingComplete: z.boolean(),
    usageComplete: z.boolean(),
    // The top spenders by cost; `breakdown` is at most the host's top-N.
    breakdown: z.array(modelKindSpendSchema),
    // True when more distinct (model, kind) groups existed than `breakdown`
    // returns; the omitted tail is summed into `otherSpend`. Authoritative
    // `cost`/`tokens` totals are unaffected.
    breakdownTruncated: z.boolean(),
    otherSpend: z
      .object({ cost: costBreakdownSchema, tokens: tokenBreakdownSchema })
      .strict(),
  })
  .strict()
  .refine(
    (spend) => spend.pricingComplete === (spend.unpricedCallCount === 0),
    "pricingComplete must equal (unpricedCallCount === 0)",
  );
export type ProjectSpend = z.infer<typeof projectSpendSchema>;

export const accountSpendRowSchema = z
  .object({
    projectSlug: z.string().min(1),
    deletedAt: z.string().datetime().nullable(),
    spend: projectSpendSchema,
  })
  .strict();
export type AccountSpendRow = z.infer<typeof accountSpendRowSchema>;

/** A half-open `[from, to)` window in epoch milliseconds; either bound may be
 *  null (open on that side). */
export type SpendWindow = { from: number | null; to: number | null };

/** Serialize a window to the endpoints' query params — a bound is included only
 *  when set, as a decimal string. Shared so both clients serialize identically. */
export function toSpendQuery(window: SpendWindow): Record<string, string> {
  const query: Record<string, string> = {};
  if (window.from !== null) {
    query.from = String(window.from);
  }
  if (window.to !== null) {
    query.to = String(window.to);
  }
  return query;
}
