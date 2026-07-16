import { describe, it, expect, vi, afterEach } from "vitest";
import { CostGuard, TimeGuard } from "./guard.js";
import { GuardScope, GuardApproveError } from "./guardScope.js";
import { StateStack } from "./state/stateStack.js";

afterEach(() => vi.restoreAllMocks());

/** A cost+time scope pushed the way _pushGuard does it. */
function pushScope(stack: StateStack, costLimit: number, timeLimitMs: number) {
  const cost = new CostGuard(costLimit);
  const time = new TimeGuard(timeLimitMs);
  stack.pushGuard(cost);
  stack.pushGuard(time);
  const ids = [cost.guardId, time.guardId];
  cost.scopeIds = ids;
  time.scopeIds = ids;
  return { cost, time, ids };
}

describe("GuardScope.resolve", () => {
  it("resolves both members from either tripped member, innermost-first", () => {
    const stack = new StateStack();
    const { cost, time } = pushScope(stack, 1, 60000);
    const scope = GuardScope.resolve(stack, cost)!;
    expect(scope.memberFor("cost")).toBe(cost);
    expect(scope.memberFor("time")).toBe(time);
  });

  it("treats an empty scopeIds as a single-member scope (root budgets)", () => {
    const stack = new StateStack();
    const g = new CostGuard(1);
    stack.pushGuard(g);
    const scope = GuardScope.resolve(stack, g)!;
    expect(scope.memberIds()).toEqual([g.guardId]);
  });

  it("returns null when no member is on the stack", () => {
    const stack = new StateStack();
    const foreign = new CostGuard(1);
    expect(GuardScope.resolve(stack, foreign)).toBeNull();
  });
});

describe("GuardScope.extend", () => {
  it("grants additively per named dimension and re-trips at the new limit (spend-shaped)", () => {
    const stack = new StateStack();
    const { cost } = pushScope(stack, 0.5, 60000);
    stack.chargeGuards(0.6);                      // over
    expect(stack.detectTrippedGuard()).not.toBeNull();
    GuardScope.resolve(stack, cost)!.extend({ maxCost: 0.5 }, "cost");
    expect(stack.detectTrippedGuard()).toBeNull(); // 0.6 ≤ 1.0
    stack.chargeGuards(0.3);
    expect(stack.detectTrippedGuard()).toBeNull(); // 0.9 fits the grant
    stack.chargeGuards(0.2);
    expect(stack.detectTrippedGuard()).not.toBeNull(); // 1.1 > 1.0: still meters
  });

  it("extends BOTH members when the payload names both dimensions", () => {
    const stack = new StateStack();
    const { cost, time } = pushScope(stack, 0.5, 60000);
    GuardScope.resolve(stack, cost)!.extend(
      { maxCost: 0.5, maxTime: 30000 },
      "cost",
    );
    expect(cost.currentLimit()).toBe(1.0);
    expect(time.currentLimit()).toBe(90000);
  });

  it("clamps a negative grant to zero with a warning, and the answer is then a livelock error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stack = new StateStack();
    const { cost } = pushScope(stack, 0.5, 60000);
    stack.chargeGuards(0.6);
    expect(() =>
      GuardScope.resolve(stack, cost)!.extend({ maxCost: -2 }, "cost"),
    ).toThrow(GuardApproveError);
    expect(warn).toHaveBeenCalled();
    expect(cost.currentLimit()).toBe(0.5); // metering intact — the point
  });

  it("disarm stops metering explicitly; the guard never trips again", () => {
    const stack = new StateStack();
    const { cost } = pushScope(stack, 0.5, 60000);
    stack.chargeGuards(0.6);
    GuardScope.resolve(stack, cost)!.extend({ disarm: ["cost"] }, "cost");
    expect(stack.detectTrippedGuard()).toBeNull();
    stack.chargeGuards(100);
    expect(stack.detectTrippedGuard()).toBeNull();
  });

  it("a useless approval (tripped dimension still over and armed) is an error", () => {
    const stack = new StateStack();
    const { cost } = pushScope(stack, 0.5, 60000);
    stack.chargeGuards(0.6);
    expect(() =>
      GuardScope.resolve(stack, cost)!.extend({}, "cost"),
    ).toThrow(/still exceeded/);
    expect(() =>
      GuardScope.resolve(stack, cost)!.extend({ maxTime: 5000 }, "cost"),
    ).toThrow(/still exceeded/);
  });

  it("a payload naming a dimension the scope lacks is an error", () => {
    const stack = new StateStack();
    const g = new CostGuard(0.5);
    stack.pushGuard(g);
    expect(() =>
      GuardScope.resolve(stack, g)!.extend({ maxTime: 5000 }, "cost"),
    ).toThrow(/no time limit/);
  });

  it("a scope containing a root budget refuses extension", () => {
    const stack = new StateStack();
    const g = new CostGuard(0.5);
    g.isRootBudget = true;
    stack.pushGuard(g);
    expect(() =>
      GuardScope.resolve(stack, g)!.extend({ maxCost: 5 }, "cost"),
    ).toThrow(/root budget/);
  });
});

describe("serialization and cloning of the new guard fields", () => {
  it("scopeIds, disarmed, and isRootBudget round-trip through JSON on both variants", async () => {
    const { guardFromJSON } = await import("./guard.js");
    const cost = new CostGuard(1);
    cost.scopeIds = ["a", "b"];
    cost.isRootBudget = true;
    cost.disarm();
    const restoredCost = guardFromJSON(cost.toJSON());
    expect(restoredCost.scopeIds).toEqual(["a", "b"]);
    expect(restoredCost.isRootBudget).toBe(true);
    expect((restoredCost as CostGuard).disarmed).toBe(true);

    const time = new TimeGuard(60000);
    time.scopeIds = ["a", "b"];
    const restoredTime = guardFromJSON(time.toJSON());
    expect(restoredTime.scopeIds).toEqual(["a", "b"]);
  });

  it("TimeGuard.cloneForBranch hand-copies scopeIds/isRootBudget/disarmed", () => {
    const parent = new StateStack();
    const g = new TimeGuard(60000);
    g.scopeIds = ["a", "b"];
    g.isRootBudget = true;
    g.install(parent);
    const clone = g.cloneForBranch(parent, new StateStack())!;
    expect(clone.scopeIds).toEqual(["a", "b"]);
    expect(clone.isRootBudget).toBe(true);
    g.uninstall(parent);
  });
});

describe("TimeGuard.extendBudget", () => {
  // PR 2 contract: extendBudget serves an UNTRIPPED time member (approve
  // names maxTime while the COST member tripped — time trips still throw
  // in PR 2 and never reach extend). Re-arming a guard whose controller
  // has already fired needs the derived-signal work and is PR 3's
  // re-arm, by plan.
  it("re-arms the running timer against the new limit (the old deadline must not fire)", () => {
    vi.useFakeTimers();
    const stack = new StateStack();
    const g = new TimeGuard(500);
    g.install(stack);
    vi.advanceTimersByTime(300);           // 300 of 500 elapsed (timer time)
    g.extendBudget(1000);                  // limit now 1500, timer re-armed
    vi.advanceTimersByTime(300);           // past the OLD 500 deadline
    expect(g.isTripped()).toBe(false);     // old timer was cancelled — the point
    expect(g.check(stack)).toBeNull();
    vi.advanceTimersByTime(1500);          // past the NEW deadline
    expect(g.isTripped()).toBe(true);      // still meters at the new limit
    expect(g.check(stack)).not.toBeNull();
    g.uninstall(stack);
    vi.useRealTimers();
  });

  it("resets both trip latches so the extended guard is armed, not consumed", () => {
    vi.useFakeTimers();
    const stack = new StateStack();
    const g = new TimeGuard(500);
    g.install(stack);
    vi.advanceTimersByTime(500);           // trips
    expect(g.check(stack)).not.toBeNull(); // consumes
    expect(g.check(stack)).toBeNull();     // consumed latch holds
    g.extendBudget(1000);
    // Both latches reset: the guard reports armed-and-under-budget
    // state (full re-trip of an already-aborted controller is PR 3).
    expect(g.isTripped()).toBe(false);
    expect(g.overBudgetAndArmed()).toBe(false);
    g.uninstall(stack);
    vi.useRealTimers();
  });
});
