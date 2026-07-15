import { EXIT_CODE_BUDGET_EXCEEDED } from "../constants.js";
import { isGuardExceededError, GuardExceededError } from "./guard.js";

/** User-facing one-line message for a tripped top-level budget. */
export function formatBudgetExceeded(e: GuardExceededError): string {
  if (e.type === "cost") {
    return `Exceeded cost limit of $${e.limit} (used $${e.spent})`;
  }
  return `Exceeded time limit of ${e.limit}ms (ran ${e.spent}ms)`;
}

/** If `error` is a top-level budget trip, report it and exit with code 3.
 *  Otherwise return so the caller can handle it as an ordinary crash. Only a
 *  ROOT guard (no owning try) reaches the compiled entry's catch — a user
 *  guard() trip is always converted to a Result by _runGuarded, so this
 *  never misfires on those. */
export function reportBudgetExceededAndExit(error: unknown): void {
  if (isGuardExceededError(error)) {
    console.error(formatBudgetExceeded(error));
    process.exit(EXIT_CODE_BUDGET_EXCEEDED);
  }
}
