import { agency, isGuardExceededError } from "agency-lang/runtime";

// `agency.addCost` charges every installed guard then calls
// `stack.enforceGuards()`, which throws `GuardExceededError`
// synchronously when a CostGuard's spent total exceeds its limit.
// This test pins that the trip propagates as a catchable error
// inside the helper, so user code can surface a structured failure
// without halting the whole run.
export async function run() {
  try {
    return await agency.withCostGuard(0.01, async () => {
      // Single over-budget charge — 0.05 > 0.01 limit. enforceGuards
      // throws on this line, before the function ever returns.
      agency.addCost(0.05);
      return { tripped: false };
    });
  } catch (e) {
    if (isGuardExceededError(e)) {
      return {
        tripped: true,
        type: e.type,
        limit: e.limit,
        spent: e.spent,
      };
    }
    throw e;
  }
}
