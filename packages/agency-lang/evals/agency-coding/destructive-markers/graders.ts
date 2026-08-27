import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "retry-markers",
    standard: `
    Here are the two retry markers:

    export idempotent def lookupPrice(sku: string): number {
      return priceOf(sku)
    }

    export def chargeCard(amount: number): Result<string> raises <payments::charge> {
      raise payments::charge("Charge \${amount}?", { amount: amount })
      destructive {
        return success(charge(amount))
      }
    }

    \`idempotent\` says a tool is always safe to re-run, so the LLM may call it again after a failure. A \`destructive { }\` region says the opposite: once the region starts, a failure removes the tool from the LLM, because the charge may have half-happened. The interrupt sits outside the region, so a rejected approval leaves the tool callable.

    Make sure that:
    1. lookupPrice is marked \`idempotent\`.
    2. the call to charge is inside a \`destructive { }\` region, or chargeCard is a \`destructive def\`.
    3. The chargeCard function raises an interrupt.
    4. the interrupt is raised before the destructive region, not inside it.

    All four of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { charge, priceOf } from "./payments.agency"

export idempotent def lookupPrice(sku: string): number {
  """
  Price of an item. Safe to call any number of times.
  """
  return priceOf(sku)
}

export def chargeCard(amount: number): Result<string> raises <payments::charge> {
  """
  Charge the customer's card. Asks before charging.
  """
  raise payments::charge("Charge \${amount}?", { amount: amount })
  destructive {
    return success(charge(amount))
  }
}`,
  }),
];
