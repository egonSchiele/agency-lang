import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "../constants.js";
import { CostGuard, TimeGuard } from "./guard.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import type { StateStack } from "./state/stateStack.js";

/** Install a root cost/time guard from AGENCY_MAX_COST / AGENCY_MAX_TIME.
 *  Applies the disable rule: cost < 0 installs nothing; time <= 0 installs
 *  nothing (cost 0 IS a real limit — no paid spend, local-models-only).
 *  Called once at the root, next to installRunPolicyHandler, before the
 *  node body runs, so the budget is outermost and cannot be bypassed.
 *  No-op in IPC subprocesses — a child's budget is owned by the parent's
 *  guard, which meters the subprocess through the branch clone.
 *
 *  pushGuard() installs immediately, so a time budget's clock starts at
 *  run start — the intended whole-run semantics. Interrupt halts and
 *  input() waits still pause it like any other time guard. */
export function installRootBudget(stack: StateStack): void {
  if (isIpcMode()) return;
  const rawCost = process.env[AGENCY_MAX_COST];
  if (rawCost !== undefined) {
    const cost = parseBudgetValue(rawCost, AGENCY_MAX_COST);
    if (cost >= 0) {
      stack.pushGuard(new CostGuard(cost));
    }
  }
  const rawTime = process.env[AGENCY_MAX_TIME];
  if (rawTime !== undefined) {
    const ms = parseBudgetValue(rawTime, AGENCY_MAX_TIME);
    if (ms > 0) {
      stack.pushGuard(new TimeGuard(ms));
    }
  }
}

/** FAIL CLOSED on a malformed budget value. The env is an internal
 *  carrier and the CLI validates before setting it, so a non-finite
 *  value here means a hand-set env or a bug — and for a cost-control
 *  feature, silently running UNBOUNDED is the wrong failure direction.
 *  Refuse the run instead. (Negative values are not malformed: they are
 *  the documented disable range and fall through the install checks.) */
function parseBudgetValue(raw: string, name: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new Error(
      `${name} is set but not a finite number (got "${raw}"). Refusing to ` +
        `run without the requested budget — unset it or pass a valid value.`,
    );
  }
  return n;
}
