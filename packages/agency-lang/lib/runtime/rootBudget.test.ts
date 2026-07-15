import { describe, test, expect, afterEach } from "vitest";
import { installRootBudget } from "@/runtime/rootBudget.js";
import { StateStack } from "@/runtime/state/stateStack.js";
import { CostGuard, TimeGuard } from "@/runtime/guard.js";
import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "@/constants.js";

afterEach(() => {
  delete process.env[AGENCY_MAX_COST];
  delete process.env[AGENCY_MAX_TIME];
});

describe("installRootBudget", () => {
  test("pushes a CostGuard for a non-negative cost", () => {
    process.env[AGENCY_MAX_COST] = "0.5";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.some((g) => g instanceof CostGuard)).toBe(true);
  });
  test("cost 0 still installs (local-only limit)", () => {
    process.env[AGENCY_MAX_COST] = "0";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.some((g) => g instanceof CostGuard)).toBe(true);
  });
  test("negative cost installs nothing", () => {
    process.env[AGENCY_MAX_COST] = "-1";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.length).toBe(0);
  });
  test("time <= 0 installs nothing; time > 0 installs a TimeGuard", () => {
    process.env[AGENCY_MAX_TIME] = "0";
    const s1 = new StateStack();
    installRootBudget(s1);
    expect(s1.guards.length).toBe(0);

    process.env[AGENCY_MAX_TIME] = "5000";
    const s2 = new StateStack();
    installRootBudget(s2);
    expect(s2.guards.some((g) => g instanceof TimeGuard)).toBe(true);
  });
  test("no env vars: no guards", () => {
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards.length).toBe(0);
  });
  test("both set: cost then time, both installed", () => {
    process.env[AGENCY_MAX_COST] = "1.5";
    process.env[AGENCY_MAX_TIME] = "60000";
    const stack = new StateStack();
    installRootBudget(stack);
    expect(stack.guards).toHaveLength(2);
    expect(stack.guards[0]).toBeInstanceOf(CostGuard);
    expect(stack.guards[1]).toBeInstanceOf(TimeGuard);
  });
});
