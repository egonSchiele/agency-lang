import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CostGuard,
  GuardExceededError,
  TimeGuard,
  guardFromJSON,
  isGuardExceededError,
} from "./guard.js";
import { StateStack } from "./state/stateStack.js";

describe("GuardExceededError", () => {
  it("is an Error subclass with name, type, limit, spent fields", () => {
    const err = new GuardExceededError("cost", 2.0, 2.5);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GuardExceededError);
    expect(err.name).toBe("GuardExceededError");
    expect(err.type).toBe("cost");
    expect(err.limit).toBe(2.0);
    expect(err.spent).toBe(2.5);
    expect(err.message).toContain("cost");
    expect(err.message).toContain("2");
  });

  it("supports the time variant", () => {
    const err = new GuardExceededError("time", 1000, 1234);
    expect(err.type).toBe("time");
    expect(err.limit).toBe(1000);
    expect(err.spent).toBe(1234);
  });
});

describe("isGuardExceededError", () => {
  it("returns true for a GuardExceededError instance", () => {
    expect(
      isGuardExceededError(new GuardExceededError("cost", 1, 2)),
    ).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isGuardExceededError(new Error("oops"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isGuardExceededError(null)).toBe(false);
    expect(isGuardExceededError(undefined)).toBe(false);
    expect(isGuardExceededError("error")).toBe(false);
    expect(isGuardExceededError({})).toBe(false);
  });
});

describe("CostGuard", () => {
  it("captures costAtPush at install time", () => {
    const stack = new StateStack();
    stack.localCost = 0.5;
    const g = new CostGuard(2.0);
    g.install(stack);
    expect(g.check(stack)).toBeNull();
    stack.localCost = 2.4;
    expect(g.check(stack)).toBeNull(); // 1.9 spent, within limit
    stack.localCost = 2.6;
    const err = g.check(stack)!;
    expect(err).toBeInstanceOf(GuardExceededError);
    expect(err.type).toBe("cost");
    expect(err.limit).toBe(2.0);
    expect(err.spent).toBeCloseTo(2.1, 5);
  });

  it("cloneForBranch rebases costAtPush onto the child's localCost", () => {
    const parent = new StateStack();
    parent.localCost = 10;
    const g = new CostGuard(5);
    g.install(parent);
    const child = new StateStack();
    child.localCost = 10;
    const cloned = g.cloneForBranch(parent, child) as CostGuard;
    expect(cloned).toBeInstanceOf(CostGuard);
    // Child has accumulated 4 more cost — within limit.
    child.localCost = 14;
    expect(cloned.check(child)).toBeNull();
    // Child accumulates 6 more — trips the clone.
    child.localCost = 16;
    expect(cloned.check(child)!.spent).toBeCloseTo(6, 5);
  });

  it("round-trips through JSON", () => {
    const stack = new StateStack();
    stack.localCost = 1.5;
    const g = new CostGuard(3.0);
    g.install(stack);
    const json = g.toJSON();
    expect(json).toEqual({ kind: "cost", costLimit: 3.0, costAtPush: 1.5 });
    const restored = guardFromJSON(json) as CostGuard;
    expect(restored).toBeInstanceOf(CostGuard);
    stack.localCost = 5;
    expect(restored.check(stack)!.spent).toBeCloseTo(3.5, 5);
  });
});

describe("TimeGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("install composes its AbortController into stack.abortSignal", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    g.install(stack);
    expect(stack.abortSignal).toBeDefined();
    expect(stack.abortSignal!.aborted).toBe(false);
  });

  it("uninstall restores the previous abort signal", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    g.install(stack);
    g.uninstall(stack);
    expect(stack.abortSignal).toBeUndefined();
  });

  it("composes with an existing stack.abortSignal", () => {
    const stack = new StateStack();
    const outerCtl = new AbortController();
    stack.abortSignal = outerCtl.signal;
    const g = new TimeGuard(1000);
    g.install(stack);
    const composed = stack.abortSignal!;
    expect(composed).not.toBe(outerCtl.signal); // composed signal
    outerCtl.abort();
    expect(composed.aborted).toBe(true);
  });

  it("trips after timeLimit ms and check() returns the error", () => {
    const stack = new StateStack();
    const g = new TimeGuard(500);
    g.install(stack);
    expect(g.check(stack)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(stack.abortSignal!.aborted).toBe(true);
    const err = g.check(stack)!;
    expect(err).toBeInstanceOf(GuardExceededError);
    expect(err.type).toBe("time");
    expect(err.limit).toBe(500);
  });

  it("pause is idempotent — multiple calls charge elapsedMs once", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    g.install(stack);
    vi.advanceTimersByTime(200);
    g.pause();
    g.pause();
    g.pause();
    const json = g.toJSON() as { kind: "time"; elapsedMs: number };
    expect(json.elapsedMs).toBeCloseTo(200, 0);
  });

  it("resume is idempotent — multiple calls arm timer once", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    g.install(stack);
    vi.advanceTimersByTime(200);
    g.pause();
    g.resume(stack);
    g.resume(stack); // second call is a no-op
    g.resume(stack);
    vi.advanceTimersByTime(800); // total compute time now 1000
    expect(stack.abortSignal!.aborted).toBe(true);
  });

  it("pause/resume cycle preserves remaining budget", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    g.install(stack);
    vi.advanceTimersByTime(300);
    g.pause();
    // Time passes while paused — does NOT count.
    vi.advanceTimersByTime(10000);
    g.resume(stack);
    vi.advanceTimersByTime(699);
    expect(stack.abortSignal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(stack.abortSignal!.aborted).toBe(true);
  });

  it("toJSON during a live window charges the in-flight delta", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    g.install(stack);
    vi.advanceTimersByTime(123);
    const json = g.toJSON() as { kind: "time"; elapsedMs: number };
    expect(json.elapsedMs).toBeCloseTo(123, 0);
  });

  it("fromJSON round-trips elapsedMs and timeLimit; starts paused", () => {
    const json = {
      kind: "time" as const,
      timeLimit: 1000,
      elapsedMs: 400,
    };
    const restored = guardFromJSON(json) as TimeGuard;
    expect(restored).toBeInstanceOf(TimeGuard);
    // Resume should re-arm with 600ms remaining.
    const stack = new StateStack();
    restored.resume(stack);
    vi.advanceTimersByTime(599);
    expect(stack.abortSignal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(stack.abortSignal!.aborted).toBe(true);
  });

  it("cloneForBranch returns undefined", () => {
    const parent = new StateStack();
    const child = new StateStack();
    const g = new TimeGuard(1000);
    g.install(parent);
    expect(g.cloneForBranch(parent, child)).toBeUndefined();
  });

  it("check() charges in-flight window so spent reflects elapsed time", () => {
    // Without inFlight-charging, a tripped guard whose check is called
    // mid-window would report spent=0 because no pause has happened.
    // Assert the real elapsed (~250) — a bug that returned timeLimit
    // instead of elapsedMs + inFlight would slip past `>= 100`.
    const stack = new StateStack();
    const g = new TimeGuard(100);
    g.install(stack);
    vi.advanceTimersByTime(250);
    const err = g.check(stack)!;
    expect(err.spent).toBeGreaterThan(200);
    expect(err.spent).toBeLessThan(300);
  });

  it("check() consumes the trip — subsequent calls return null", () => {
    // The stdlib `guard`'s `try` catches the first trip and translates
    // it to a Failure. The next runner step would re-trip on the same
    // still-aborted signal without consumption.
    const stack = new StateStack();
    const g = new TimeGuard(100);
    g.install(stack);
    vi.advanceTimersByTime(150);
    expect(g.check(stack)).toBeInstanceOf(GuardExceededError);
    expect(g.check(stack)).toBeNull();
    expect(g.check(stack)).toBeNull();
  });

  it("isTripped() stays true after check consumes the trip", () => {
    // Runner.shouldSkip uses isTripped() to distinguish a still-aborted
    // signal owned by an already-consumed guard (don't silent-halt
    // cleanup steps) from a race-loser branch cancel.
    const stack = new StateStack();
    const g = new TimeGuard(100);
    g.install(stack);
    expect(g.isTripped()).toBe(false);
    vi.advanceTimersByTime(150);
    expect(g.isTripped()).toBe(true);
    g.check(stack); // consume
    expect(g.isTripped()).toBe(true);
  });
});

describe("guardFromJSON", () => {
  it("throws on an unknown kind rather than silently returning undefined", () => {
    expect(() => guardFromJSON({ kind: "depth" } as any)).toThrow();
  });
});

describe("CostGuard.isTripped", () => {
  it("always returns false — cost guards don't mutate abortSignal", () => {
    const stack = new StateStack();
    stack.localCost = 0;
    const g = new CostGuard(1);
    g.install(stack);
    expect(g.isTripped()).toBe(false);
    stack.localCost = 100; // way over limit
    expect(g.check(stack)).toBeInstanceOf(GuardExceededError);
    // Even with a tripped check, the CostGuard doesn't claim the abort
    // signal — it has none.
    expect(g.isTripped()).toBe(false);
  });
});

describe("StateStack guard lifecycle", () => {
  it("pushGuard installs and popGuard uninstalls", () => {
    const stack = new StateStack();
    stack.localCost = 5;
    const g = new CostGuard(5);
    stack.pushGuard(g);
    expect(stack.guards).toContain(g);
    // install captured costAtPush=5. spend=10-5=5 is at the limit; check
    // is strictly > so still null. At 5.01 it trips.
    stack.localCost = 10;
    expect(g.check(stack)).toBeNull();
    stack.localCost = 10.01;
    expect(g.check(stack)!.spent).toBeCloseTo(5.01, 5);
    stack.popGuard();
    expect(stack.guards).not.toContain(g);
  });

  it("toJSON / fromJSON round-trips a mixed guard stack", () => {
    const stack = new StateStack();
    stack.localCost = 2;
    stack.pushGuard(new CostGuard(3));
    const json = stack.toJSON();
    const restored = StateStack.fromJSON(json);
    expect(restored.guards.length).toBe(1);
    expect(restored.guards[0]).toBeInstanceOf(CostGuard);
  });
});
