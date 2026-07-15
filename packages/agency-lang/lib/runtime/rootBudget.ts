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
    const cost = Number(rawCost);
    if (Number.isFinite(cost) && cost >= 0) {
      stack.pushGuard(new CostGuard(cost));
    }
  }
  const rawTime = process.env[AGENCY_MAX_TIME];
  if (rawTime !== undefined) {
    const ms = Number(rawTime);
    if (Number.isFinite(ms) && ms > 0) {
      stack.pushGuard(new TimeGuard(ms));
    }
  }
}
