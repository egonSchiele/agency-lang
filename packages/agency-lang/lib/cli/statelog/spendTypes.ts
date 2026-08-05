// The statelog spend wire types — the single source of truth for the shape the
// per-project and account spend endpoints return, and the query serializer both
// clients share. The Zod schemas own the numeric invariants; the TypeScript
// types are inferred from them so a hand-written type cannot drift from its
// runtime validator.

import { z } from "zod";

const nonNegativeSafeInt = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a safe integer");

export const projectSpendSchema = z
  .object({
    pricedCost: z.number().finite().nonnegative(),
    inputTokens: nonNegativeSafeInt,
    outputTokens: nonNegativeSafeInt,
    invocationCount: nonNegativeSafeInt,
    unpricedCallCount: nonNegativeSafeInt,
    pricingComplete: z.boolean(),
    usageComplete: z.boolean(),
  })
  .refine(
    (spend) => spend.pricingComplete === (spend.unpricedCallCount === 0),
    "pricingComplete must equal (unpricedCallCount === 0)",
  );
export type ProjectSpend = z.infer<typeof projectSpendSchema>;

export const accountSpendRowSchema = z.object({
  projectSlug: z.string().min(1),
  deletedAt: z.string().datetime().nullable(),
  spend: projectSpendSchema,
});
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
