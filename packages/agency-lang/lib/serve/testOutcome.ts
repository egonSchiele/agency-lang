// Test-only builders for ServedInvocationOutcome, so adapter/discovery unit
// tests can supply plain-JS invokers without spinning up a real runtime.
import type { InvocationUsageSnapshot, ServedInvocationOutcome } from "../runtime/invocationUsage.js";

const ZERO_SNAPSHOT: InvocationUsageSnapshot = {
  usage: {
    cost: { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" },
    tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 },
    unknownCostCallCount: 0,
    pricingComplete: true,
    entries: [],
  },
  usageComplete: true,
};

/** A returned outcome carrying a fixed usage snapshot and trace id (override
 *  `usage`/`traceId` when a test asserts specific figures or identity). */
export function returnedOutcome<T>(
  value: T,
  overrides: Partial<Pick<ServedInvocationOutcome<T>, "usage" | "usageComplete" | "traceId">> = {},
): ServedInvocationOutcome<T> {
  return { status: "returned", value, traceId: "test-trace", ...ZERO_SNAPSHOT, ...overrides };
}

/** A threw outcome carrying the identical error. */
export function threwOutcome(
  error: unknown,
  overrides: Partial<Pick<ServedInvocationOutcome<never>, "usage" | "usageComplete" | "traceId">> = {},
): ServedInvocationOutcome<never> {
  return { status: "threw", error, traceId: "test-trace", ...ZERO_SNAPSHOT, ...overrides };
}

/** The PUBLIC raw `invoke` member on an ExportedFunction/Node. Adapter tests
 *  drive the served path (`invokeServed`), never the public `invoke`, so a fake
 *  can spread this stub to satisfy the type; calling it is a test bug. */
export const unusedPublicInvoke = {
  invoke: (async () => {
    throw new Error("public invoke is not exercised in this test (use invokeServed)");
  }) as (...args: any[]) => Promise<any>,
};
