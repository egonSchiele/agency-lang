import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "../constants.js";
import { CostGuard, TimeGuard } from "./guard.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import type { StateStack } from "./state/stateStack.js";

/** The host-authoritative root limits: the CLI flag (AGENCY_MAX_COST /
 *  AGENCY_MAX_TIME env vars) if set, else the resolved config `budget`. The flag
 *  wins per dimension, so `agency run --max-cost` still overrides an
 *  `agency.json` budget; a served agent, which has no flag, is governed by the
 *  budget its host bound via runtime-config overrides. `undefined` means "no
 *  cap this dimension"; a value still passes through the disable rule at the
 *  call site (cost < 0 / time <= 0 install nothing). FAILS CLOSED on a
 *  malformed value. */
function resolveRootLimits(contextBudget?: { maxCost?: number; maxTimeMs?: number }): {
  cost?: number;
  timeMs?: number;
} {
  const rawCost = process.env[AGENCY_MAX_COST];
  const cost =
    rawCost !== undefined
      ? parseBudgetValue(rawCost, AGENCY_MAX_COST)
      : contextBudget?.maxCost !== undefined
        ? finiteContextBudget(contextBudget.maxCost, "budget.maxCost")
        : undefined;
  const rawTime = process.env[AGENCY_MAX_TIME];
  const timeMs =
    rawTime !== undefined
      ? parseBudgetValue(rawTime, AGENCY_MAX_TIME)
      : contextBudget?.maxTimeMs !== undefined
        ? finiteContextBudget(contextBudget.maxTimeMs, "budget.maxTime")
        : undefined;
  return { cost, timeMs };
}

function pushRootGuard(stack: StateStack, guard: CostGuard | TimeGuard): void {
  // The operator's ceiling: never raises an interrupt, never extendable by user
  // code. Serialized with the guard.
  guard.isRootBudget = true;
  stack.pushGuard(guard);
}

/** Install a root cost/time budget. Applies the disable rule: cost < 0 installs
 *  nothing; time <= 0 installs nothing (cost 0 IS a real limit — no paid spend,
 *  local-models-only). Called once at the root, next to installRunPolicyHandler,
 *  before the node body runs, so the budget is outermost and cannot be bypassed.
 *  No-op in IPC subprocesses — a child's budget is owned by the parent's guard,
 *  which meters the subprocess through the branch clone.
 *
 *  pushGuard() installs immediately, so a time budget's clock starts at run
 *  start — the intended whole-run semantics. Interrupt halts and input() waits
 *  still pause it like any other time guard. */
export function installRootBudget(
  stack: StateStack,
  contextBudget?: { maxCost?: number; maxTimeMs?: number },
): void {
  if (isIpcMode()) return;
  const { cost, timeMs } = resolveRootLimits(contextBudget);
  if (cost !== undefined && cost >= 0) pushRootGuard(stack, new CostGuard(cost));
  if (timeMs !== undefined && timeMs > 0) pushRootGuard(stack, new TimeGuard(timeMs));
}

/** Re-assert the root budget on a RESUMED exec context. The root guard is
 *  serialized with the checkpoint, so on a stateless served resume its limit
 *  arrives from a client-controllable payload — a crafted resume could raise the
 *  ceiling. Clamp the restored root guard's LIMIT to the host value while
 *  KEEPING the guard (and its accumulated spend/elapsed):
 *
 *  - the limit becomes host-authoritative and un-raisable from the client;
 *  - accumulated spend is preserved, so the trusted in-process CLI resume path
 *    stays cumulative across legs — no regression — and a served client that
 *    lowers its own reported spend only hurts itself (same residual gap a
 *    stateless resume always has);
 *  - arming is untouched (restored guards are un-armed by restoreState), so this
 *    can't reintroduce a timer pop-race.
 *
 *  A dimension the host no longer caps has its restored root guard dropped
 *  (through `uninstall`); a dimension the host caps but the checkpoint had no
 *  root guard for gets a fresh guard. No-op in IPC. */
export function reinstallRootBudget(
  stack: StateStack,
  contextBudget?: { maxCost?: number; maxTimeMs?: number },
): void {
  if (isIpcMode()) return;
  const { cost, timeMs } = resolveRootLimits(contextBudget);
  const hostCost = cost !== undefined && cost >= 0 ? cost : undefined;
  const hostTimeMs = timeMs !== undefined && timeMs > 0 ? timeMs : undefined;

  let sawCost = false;
  let sawTime = false;
  const dropped: (CostGuard | TimeGuard)[] = [];
  for (const guard of stack.guards) {
    if (!guard.isRootBudget) continue;
    if (guard instanceof CostGuard) {
      sawCost = true;
      // Direct clamp (not extendBudget, which only grants upward): the host
      // ceiling replaces whatever the checkpoint carried, preserving `spent`.
      if (hostCost !== undefined) guard.costLimit = hostCost;
      else dropped.push(guard);
    } else if (guard instanceof TimeGuard) {
      sawTime = true;
      if (hostTimeMs !== undefined) guard.timeLimit = hostTimeMs;
      else dropped.push(guard);
    }
  }

  if (dropped.length > 0) {
    for (const guard of dropped) guard.uninstall(stack);
    stack.guards = stack.guards.filter((g) => !dropped.includes(g as CostGuard | TimeGuard));
    stack.rebuildAbortSignal();
  }

  // The host caps a dimension the checkpoint had no root guard for.
  if (!sawCost && hostCost !== undefined) pushRootGuard(stack, new CostGuard(hostCost));
  if (!sawTime && hostTimeMs !== undefined) pushRootGuard(stack, new TimeGuard(hostTimeMs));
}

/** FAIL CLOSED on a malformed budget value. The env is an internal
 *  carrier and the CLI validates before setting it, so a non-finite
 *  value here means a hand-set env or a bug — and for a cost-control
 *  feature, silently running UNBOUNDED is the wrong failure direction.
 *  Refuse the run instead. (Negative values are not malformed: they are
 *  the documented disable range and fall through the install checks.) */
/** FAIL CLOSED on a non-finite config/override budget number. Env values go
 *  through parseBudgetValue; this guards the RuntimeContext path (an agency.json
 *  bake or a programmatic `withRuntimeConfigOverrides` value), where
 *  TypeScript's `number` still admits NaN/Infinity. A non-finite cap is the
 *  wrong direction for a budget — Infinity installs an effectively unbounded
 *  guard, and NaN (NaN >= 0 is false) installs none at all — so refuse the run.
 *  Negatives are fine: they are the documented disable range. */
function finiteContextBudget(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `${name} is not a finite number (got ${value}). Refusing to run without ` +
        `the requested budget — fix the config or the runtime override.`,
    );
  }
  return value;
}

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
