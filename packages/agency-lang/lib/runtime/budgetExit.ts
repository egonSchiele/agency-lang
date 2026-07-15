import { EXIT_CODE_BUDGET_EXCEEDED } from "../constants.js";
import { readCause } from "./errors.js";

/** Dollars for the overrun message: bounded precision with float noise
 *  stripped, so accumulated token pricing can't surface artifacts like
 *  0.30000000000000004 in user-facing output. */
function fmtDollars(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** User-facing one-line message for a tripped top-level budget. Times
 *  render in raw ms on purpose: only the millisecond value crosses the
 *  env boundary, so the user's original unit string is not available
 *  here, and ms is unambiguous. */
export function formatBudgetExceeded(cause: {
  dimension: "cost" | "time";
  limit: number;
  spent: number;
}): string {
  if (cause.dimension === "cost") {
    return `Exceeded cost limit of $${fmtDollars(cause.limit)} (used $${fmtDollars(cause.spent)})`;
  }
  return `Exceeded time limit of ${cause.limit}ms (ran ${Math.round(cause.spent)}ms)`;
}

/** If `error` carries a guard-trip cause, report it and exit with code 3.
 *  Otherwise return so the caller handles it as an ordinary crash.
 *
 *  Detection is by CAUSE, not error class, because a root time trip can
 *  surface two ways: the runner's shouldSkip throws GuardExceededError, or
 *  an in-flight leaf op (sleep, fetch, LLM call) aborts first and throws
 *  AgencyCancelledError carrying the same guardTrip cause. Both must exit 3.
 *  Only a ROOT guard's trip reaches the compiled entry's catch — a user
 *  guard() trip is converted to a Result at its boundary by _runGuarded,
 *  so this never misfires on those. */
export function reportBudgetExceededAndExit(error: unknown): void {
  const cause = readCause(error);
  if (cause?.kind === "guardTrip") {
    console.error(formatBudgetExceeded(cause));
    process.exit(EXIT_CODE_BUDGET_EXCEEDED);
  }
}
