import { getRuntimeContext } from "./asyncContext.js";
import { recordPaidUsage } from "./recordPaidUsage.js";
import { paidCostDelta } from "./invocationUsage.js";

/** Charge `amount` USD to the active branch: account it (guards + invocation
 *  meter + subprocess relay) and enforce limits — the exact sequence the
 *  built-in llm() path runs after each completion (see lib/runtime/prompt.ts). A
 *  TS helper wrapping its own paid call site calls this so the cost participates
 *  in getCost() / guard(cost:) / per-invocation usage accounting.
 *
 *  `amount` must be a finite, nonnegative number — invalid input THROWS (via
 *  paidCostDelta) BEFORE any mutation, so a real charge is never silently
 *  dropped. Throws (a guard-trip) if enforcement fails — callers must not
 *  swallow it. */
export function addCost(amount: number): void {
  recordPaidUsage(paidCostDelta(amount));
  getRuntimeContext().stack.enforceGuards();
}

/** Add `amount` tokens to the active branch accumulator. Sibling of addCost;
 *  tokens don't interact with guards (guards are cost-based). */
export function addTokens(amount: number): void {
  getRuntimeContext().stack.localTokens += amount;
}
