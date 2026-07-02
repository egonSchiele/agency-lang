import { getRuntimeContext } from "./asyncContext.js";

/** Charge `amount` USD to the active branch, bill every active guard, and
 *  enforce limits — the exact sequence the built-in llm() path runs after each
 *  completion (see lib/runtime/prompt.ts). A TS helper wrapping its own paid
 *  call site calls this so the cost participates in getCost() / guard(cost:).
 *
 *  Throws (a guard-trip) if enforcement fails — callers must not swallow it. */
export function addCost(amount: number): void {
  const stack = getRuntimeContext().stack;
  stack.localCost += amount;
  stack.chargeGuards(amount);
  stack.enforceGuards();
}

/** Add `amount` tokens to the active branch accumulator. Sibling of addCost;
 *  tokens don't interact with guards (guards are cost-based). */
export function addTokens(amount: number): void {
  getRuntimeContext().stack.localTokens += amount;
}
