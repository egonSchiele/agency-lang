// Test-only builders for ServedInvocationOutcome, so adapter/discovery unit
// tests can supply plain-JS invokers without spinning up a real runtime.
import type { ServedInvocationOutcome } from "../runtime/invocationUsage.js";

const ZERO_SNAPSHOT = {
  usage: { pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0, pricingComplete: true },
  usageComplete: true,
} as const;

/** A returned outcome carrying a fixed usage snapshot (override `usage` when a
 *  test asserts specific figures). */
export function returnedOutcome<T>(
  value: T,
  overrides: Partial<Pick<ServedInvocationOutcome<T>, "usage" | "usageComplete">> = {},
): ServedInvocationOutcome<T> {
  return { status: "returned", value, ...ZERO_SNAPSHOT, ...overrides };
}

/** A threw outcome carrying the identical error. */
export function threwOutcome(
  error: unknown,
  overrides: Partial<Pick<ServedInvocationOutcome<never>, "usage" | "usageComplete">> = {},
): ServedInvocationOutcome<never> {
  return { status: "threw", error, ...ZERO_SNAPSHOT, ...overrides };
}
