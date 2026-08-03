import { describe, test, expect, afterEach } from "vitest";
import { installRootBudget, reinstallRootBudget } from "@/runtime/rootBudget.js";
import { StateStack } from "@/runtime/state/stateStack.js";
import { CostGuard, TimeGuard } from "@/runtime/guard.js";
import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "@/constants.js";

afterEach(() => {
  delete process.env[AGENCY_MAX_COST];
  delete process.env[AGENCY_MAX_TIME];
  // installRootBudget no-ops under AGENCY_IPC=1; clear it so a leak from
  // an IPC-mode test elsewhere can't turn these assertions flaky.
  delete process.env.AGENCY_IPC;
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
  test("malformed values FAIL CLOSED: refuse the run, never run unbounded", () => {
    process.env[AGENCY_MAX_COST] = "abc";
    expect(() => installRootBudget(new StateStack())).toThrow(/finite number/);
    delete process.env[AGENCY_MAX_COST];
    process.env[AGENCY_MAX_TIME] = "Infinity";
    expect(() => installRootBudget(new StateStack())).toThrow(/finite number/);
  });
  test("no-op in IPC mode (child budgets are the parent guard's job)", () => {
    process.env[AGENCY_MAX_COST] = "0.5";
    process.env.AGENCY_IPC = "1";
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

describe("installRootBudget with a context budget (config, no flag)", () => {
  test("installs cost and time guards from the context budget when no env is set", () => {
    const stack = new StateStack();
    installRootBudget(stack, { maxCost: 2, maxTimeMs: 5000 });
    expect(stack.guards.some((g) => g instanceof CostGuard)).toBe(true);
    expect(stack.guards.some((g) => g instanceof TimeGuard)).toBe(true);
  });
  test("context cost 0 installs (local-only limit); negative installs nothing", () => {
    const zero = new StateStack();
    installRootBudget(zero, { maxCost: 0 });
    expect(zero.guards.some((g) => g instanceof CostGuard)).toBe(true);

    const neg = new StateStack();
    installRootBudget(neg, { maxCost: -1 });
    expect(neg.guards.length).toBe(0);
  });
  test("context time <= 0 installs nothing", () => {
    const stack = new StateStack();
    installRootBudget(stack, { maxTimeMs: 0 });
    expect(stack.guards.length).toBe(0);
  });
  test("the env flag wins over the context budget, per dimension", () => {
    // Env disables cost; a context cost would have installed one — env wins.
    process.env[AGENCY_MAX_COST] = "-1";
    const disabled = new StateStack();
    installRootBudget(disabled, { maxCost: 5 });
    expect(disabled.guards.some((g) => g instanceof CostGuard)).toBe(false);
    delete process.env[AGENCY_MAX_COST];

    // Env sets cost; a disabling context is ignored — env wins.
    process.env[AGENCY_MAX_COST] = "0.5";
    const enabled = new StateStack();
    installRootBudget(enabled, { maxCost: -1 });
    expect(enabled.guards.some((g) => g instanceof CostGuard)).toBe(true);
  });
  test("no-op in IPC mode even with a context budget", () => {
    process.env.AGENCY_IPC = "1";
    const stack = new StateStack();
    installRootBudget(stack, { maxCost: 5, maxTimeMs: 5000 });
    expect(stack.guards.length).toBe(0);
  });
  test("a non-finite context budget FAILS CLOSED (Infinity/NaN never uncaps spend)", () => {
    // Infinity would install an effectively unbounded guard; NaN (NaN >= 0 is
    // false) would install none. Both must refuse the run instead. This is the
    // gate for every non-env ingress: agency.json bake and runtime overrides.
    expect(() => installRootBudget(new StateStack(), { maxCost: Infinity })).toThrow(
      /budget\.maxCost is not a finite number/,
    );
    expect(() => installRootBudget(new StateStack(), { maxCost: NaN })).toThrow(
      /budget\.maxCost is not a finite number/,
    );
    expect(() => installRootBudget(new StateStack(), { maxTimeMs: Infinity })).toThrow(
      /budget\.maxTime is not a finite number/,
    );
  });
});

describe("reinstallRootBudget (resume: host-authoritative limit)", () => {
  test("drops a restored root guard and re-installs from the context budget", () => {
    const stack = new StateStack();
    // A restored root guard whose limit the client inflated to 999.
    const stale = new CostGuard(999);
    stale.isRootBudget = true;
    stack.pushGuard(stale);

    reinstallRootBudget(stack, { maxCost: 1 });

    const roots = stack.guards.filter(
      (g): g is CostGuard => g instanceof CostGuard && g.isRootBudget,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]).not.toBe(stale);
    // The fresh guard carries the HOST limit, not the client's 999.
    expect(roots[0].costLimit).toBe(1);
  });

  test("preserves a non-root (user) guard", () => {
    const stack = new StateStack();
    const userGuard = new CostGuard(5); // isRootBudget defaults to false
    stack.pushGuard(userGuard);

    reinstallRootBudget(stack, { maxCost: 1 });

    expect(stack.guards).toContain(userGuard);
  });

  test("no host budget: drops the restored root guard, installs nothing", () => {
    const stack = new StateStack();
    const stale = new CostGuard(999);
    stale.isRootBudget = true;
    stack.pushGuard(stale);

    reinstallRootBudget(stack, undefined);

    expect(stack.guards.some((g) => g.isRootBudget)).toBe(false);
  });

  test("no-op in IPC mode (parent owns the budget)", () => {
    process.env.AGENCY_IPC = "1";
    const stack = new StateStack();
    const stale = new CostGuard(999);
    stale.isRootBudget = true;
    stack.pushGuard(stale);

    reinstallRootBudget(stack, { maxCost: 1 });

    expect(stack.guards).toEqual([stale]);
  });
});
