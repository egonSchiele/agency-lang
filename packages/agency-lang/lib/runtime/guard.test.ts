import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CostGuard,
  GuardExceededError,
  TimeGuard,
  guardFromJSON,
  isGuardExceededError,
} from "./guard.js";
import { StateStack } from "./state/stateStack.js";
import { readCause } from "./errors.js";

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
  it("tracks its own spent counter via charge()", () => {
    const stack = new StateStack();
    const g = new CostGuard(2.0);
    stack.pushGuard(g);
    expect(g.check(stack)).toBeNull();
    g.charge(1.9);
    expect(g.check(stack)).toBeNull(); // 1.9 ≤ 2.0
    g.charge(0.2);
    const err = g.check(stack)!;
    expect(err).toBeInstanceOf(GuardExceededError);
    expect(err.type).toBe("cost");
    expect(err.limit).toBe(2.0);
    expect(err.spent).toBeCloseTo(2.1, 5);
  });

  it("exposes a guardId; its check()-produced trip carries it (C1)", () => {
    // Load-bearing for C2 ownedGuardIds matching: the trip a cost guard
    // produces at a sync point must identify WHICH guard tripped.
    const stack = new StateStack();
    const g = new CostGuard(2.0);
    stack.pushGuard(g);
    g.charge(3);
    const err = g.check(stack)!;
    expect(typeof g.guardId).toBe("string");
    expect(g.guardId.length).toBeGreaterThan(0);
    expect(readCause(err)?.kind).toBe("guardTrip");
    expect((readCause(err) as { guardId: string }).guardId).toBe(g.guardId);
  });

  it("check is independent of stack.localCost", () => {
    // Cost guard no longer derives spent from stack.localCost — the
    // counter is its own field. This is what lets the same guard
    // instance be shared across parent + child branches.
    const stack = new StateStack();
    stack.localCost = 999;
    const g = new CostGuard(1.0);
    stack.pushGuard(g);
    expect(g.check(stack)).toBeNull(); // localCost ignored
    g.charge(2);
    expect(g.check(stack)!.spent).toBeCloseTo(2, 5);
  });

  it("cloneForBranch returns the same instance (shared reference)", () => {
    const parent = new StateStack();
    const g = new CostGuard(5);
    parent.pushGuard(g);
    const child = new StateStack();
    const cloned = g.cloneForBranch(parent, child);
    expect(cloned).toBe(g); // same JS object — not a clone
    // Charging through either reference mutates the same counter.
    cloned!.charge(3);
    expect(g.check(parent)).toBeNull();
    g.charge(3);
    expect(cloned!.check(child)!.spent).toBeCloseTo(6, 5); // 3 + 3
  });

  it("round-trips through JSON via spent counter", () => {
    const g = new CostGuard(3.0);
    g.install(new StateStack());
    g.charge(1.5);
    const json = g.toJSON();
    expect(json).toMatchObject({ kind: "cost", costLimit: 3.0, spent: 1.5 });
    // guardId is serialized so ownedGuardIds matching survives resume.
    expect((json as { guardId?: string }).guardId).toBe(g.guardId);
    const restored = guardFromJSON(json) as CostGuard;
    expect(restored).toBeInstanceOf(CostGuard);
    expect(restored.guardId).toBe(g.guardId); // id round-trips
    restored.charge(2);
    expect(restored.check(new StateStack())!.spent).toBeCloseTo(3.5, 5);
  });

  it("fromJSON throws on the legacy {costAtPush} shape", () => {
    // Clean breaking change: pre-shared-cost-guards checkpoints used
    // {costLimit, costAtPush} (no `spent`). Restoring them silently
    // would set spent=undefined → check() compares undefined > limit
    // → false → guard never trips. Fail loudly instead.
    expect(() =>
      CostGuard.fromJSON({ costLimit: 2.0, costAtPush: 0.5 } as any),
    ).toThrow(/spent/);
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
    stack.pushGuard(g);
    expect(stack.abortSignal).toBeDefined();
    expect(stack.abortSignal!.aborted).toBe(false);
  });

  it("uninstall restores the previous abort signal", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    stack.pushGuard(g);
    stack.popGuard();
    expect(stack.abortSignal).toBeUndefined();
  });

  it("composes with an existing stack.abortSignal", () => {
    const stack = new StateStack();
    const outerCtl = new AbortController();
    stack.abortSignal = outerCtl.signal;
    const g = new TimeGuard(1000);
    stack.pushGuard(g);
    const composed = stack.abortSignal!;
    expect(composed).not.toBe(outerCtl.signal); // composed signal
    outerCtl.abort();
    expect(composed.aborted).toBe(true);
  });

  it("trips after timeLimit ms and check() returns the error", () => {
    const stack = new StateStack();
    const g = new TimeGuard(500);
    stack.pushGuard(g);
    expect(g.check(stack)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(stack.abortSignal!.aborted).toBe(true);
    const err = g.check(stack)!;
    expect(err).toBeInstanceOf(GuardExceededError);
    expect(err.type).toBe("time");
    expect(err.limit).toBe(500);
  });

  it("check()-produced trip carries the TimeGuard's guardId — runner path (C1)", () => {
    // This is the path Runner.shouldSkip throws through. It is DISTINCT from
    // the leaf-abort path (signal.reason), which already carries the id. If
    // this regresses, after C2 a runner-path time trip carries guardId "" ,
    // fails ownedGuardIds.includes, and escapes its own guard. Do not remove.
    const stack = new StateStack();
    const g = new TimeGuard(500);
    stack.pushGuard(g);
    vi.advanceTimersByTime(500);
    const err = g.check(stack)!;
    expect(readCause(err)?.kind).toBe("guardTrip");
    expect((readCause(err) as { guardId: string }).guardId).toBe(g.guardId);
  });

  it("aborts with a structured guardTrip cause on its signal reason", () => {
    const stack = new StateStack();
    const g = new TimeGuard(500);
    stack.pushGuard(g);
    vi.advanceTimersByTime(500);
    const cause = readCause(stack.abortSignal);
    expect(cause).toMatchObject({
      kind: "guardTrip",
      dimension: "time",
      limit: 500,
      guardId: g.guardId,
    });
    // A leaf op that reads this cause and rejects with it must surface as
    // a guardTrip — this is what lets __tryCall convert it to a Failure
    // instead of letting a bare cancel escape the guarded block.
    expect((cause as { spent: number }).spent).toBeGreaterThanOrEqual(0);
  });

  it("pause is idempotent — multiple calls charge elapsedMs once", () => {
    const stack = new StateStack();
    const g = new TimeGuard(1000);
    stack.pushGuard(g);
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
    stack.pushGuard(g);
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
    stack.pushGuard(g);
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
    stack.pushGuard(g);
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
    // Resume should re-arm with 600ms remaining. Mirror the real restore
    // path: fromJSON puts guards straight into stack.guards (no install),
    // and the first runner step's resume() arms them — the derived
    // composite only sees guards that are on the stack.
    const stack = new StateStack();
    stack.guards.push(restored);
    restored.resume(stack);
    vi.advanceTimersByTime(599);
    expect(stack.abortSignal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(stack.abortSignal!.aborted).toBe(true);
  });

  it("cloneForBranch inherits the parent's REMAINING budget", () => {
    const parent = new StateStack();
    const child = new StateStack();
    const g = new TimeGuard(10_000);
    g.addElapsed(3_000); // parent already spent 3s before the fork
    const clone = g.cloneForBranch(parent, child);
    expect(clone).toBeInstanceOf(TimeGuard);
    // Child gets the remaining 7s, not a fresh 10s: the path
    // "parent work, then branch" must not exceed the original budget.
    expect((clone as TimeGuard).timeLimit).toBe(7_000);
  });

  it("cloneForBranch carries the parent's guardId", () => {
    // Load-bearing for trip ownership: a trip inside a branch must be
    // owned by the OUTER guard boundary's try (ownedGuardIds matching),
    // exactly like a shared CostGuard's trips are.
    const g = new TimeGuard(1000);
    const clone = g.cloneForBranch(new StateStack(), new StateStack());
    expect((clone as TimeGuard).guardId).toBe(g.guardId);
  });

  it("cloneForBranch floors the remaining budget at 1ms", () => {
    const g = new TimeGuard(1000);
    g.addElapsed(5_000); // over budget already
    const clone = g.cloneForBranch(new StateStack(), new StateStack());
    expect((clone as TimeGuard).timeLimit).toBe(1);
  });

  it("snapshotElapsed/addElapsed round-trip for join accounting", () => {
    const g = new TimeGuard(10_000);
    expect(g.snapshotElapsed()).toBe(0);
    g.addElapsed(1_200);
    g.addElapsed(800);
    expect(g.snapshotElapsed()).toBe(2_000);
  });

  it("check() charges in-flight window so spent reflects elapsed time", () => {
    // Without inFlight-charging, a tripped guard whose check is called
    // mid-window would report spent=0 because no pause has happened.
    // Assert the real elapsed (~250) — a bug that returned timeLimit
    // instead of elapsedMs + inFlight would slip past `>= 100`.
    const stack = new StateStack();
    const g = new TimeGuard(100);
    stack.pushGuard(g);
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
    stack.pushGuard(g);
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
    stack.pushGuard(g);
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
    const g = new CostGuard(1);
    stack.pushGuard(g);
    expect(g.isTripped()).toBe(false);
    g.charge(100); // way over limit
    expect(g.check(stack)).toBeInstanceOf(GuardExceededError);
    // Even with a tripped check, the CostGuard doesn't claim the abort
    // signal — it has none.
    expect(g.isTripped()).toBe(false);
  });
});

describe("StateStack guard lifecycle", () => {
  it("pushGuard installs and popGuard uninstalls", () => {
    const stack = new StateStack();
    const g = new CostGuard(5);
    stack.pushGuard(g);
    expect(stack.guards).toContain(g);
    // spend=5 is at the limit; check is strictly > so still null. At
    // 5.01 it trips.
    g.charge(5);
    expect(g.check(stack)).toBeNull();
    g.charge(0.01);
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

describe("guard labels", () => {
  it("a labeled CostGuard trip carries the label in its message and cause", () => {
    const g = new CostGuard(1.0, "research");
    g.charge(2.0);
    const err = g.check(new StateStack());
    expect(err).not.toBeNull();
    expect(err!.message).toContain('guard "research" exceeded');
    expect(readCause(err!)).toMatchObject({ kind: "guardTrip", label: "research" });
  });

  it("an unlabeled trip has no label in message or cause", () => {
    const g = new CostGuard(1.0);
    g.charge(2.0);
    const err = g.check(new StateStack());
    expect(err!.message).not.toContain('"');
    expect((readCause(err!) as { label?: string }).label).toBeUndefined();
  });

  it("the label survives a serialization round-trip (both guard kinds)", () => {
    const cost = CostGuard.fromJSON(
      JSON.parse(JSON.stringify(new CostGuard(1.0, "budget").toJSON())),
    );
    expect(cost.label).toBe("budget");
    const time = TimeGuard.fromJSON(
      JSON.parse(JSON.stringify(new TimeGuard(500, "clock").toJSON())) as {
        timeLimit: number;
        elapsedMs: number;
        guardId?: string;
        label?: string;
      },
    );
    expect(time.label).toBe("clock");
  });

  it("is absent from JSON when unset", () => {
    expect("label" in new CostGuard(1.0).toJSON()).toBe(false);
  });

  it("a TimeGuard branch clone keeps the parent's label", () => {
    const parent = new TimeGuard(500, "clock");
    const clone = parent.cloneForBranch(new StateStack(), new StateStack());
    expect((clone as TimeGuard).label).toBe("clock");
    expect((clone as TimeGuard).guardId).toBe(parent.guardId);
  });
});

describe("suspension", () => {
  it("a suspended TimeGuard ignores beforeStep-style resume() calls", () => {
    const g = new TimeGuard(60000);
    const stack = new StateStack();
    stack.pushGuard(g);
    g.suspend();
    // Runner.beforeStep resumes every guard at every step entry — a
    // handler body executes steps, so this MUST stay a no-op while
    // suspended or the clock restarts mid-deliberation. `state`
    // staying "paused" is the deterministic signal that resume() was
    // ignored.
    g.resume(stack);
    expect((g as any).state).toBe("paused");
    g.unsuspend();
    g.resume(stack);
    expect((g as any).state).toBe("running");
    stack.popGuard();
  });

  it("a suspended TimeGuard's check() reports nothing even when tripped", () => {
    const g = new TimeGuard(60000);
    (g as any).tripped = true;
    g.suspend();
    expect(g.check(new StateStack())).toBeNull();
    g.unsuspend();
    expect(g.check(new StateStack())).not.toBeNull();
  });

  it("CostGuard suspension is stack-scoped, never object-scoped: the shared object still meters sibling branches", () => {
    // The same CostGuard object appears on two branch stacks
    // (cloneForBranch returns `this`). Suspending it FOR A HANDLER on
    // branch A must not blind branch B's enforcement or charging.
    const g = new CostGuard(0.5);
    const branchA = new StateStack();
    const branchB = new StateStack();
    branchA.pushGuard(g);
    branchB.pushGuard(g.cloneForBranch(branchA, branchB)!);

    const token = branchA.beginSuspension([]);
    // Branch A (the handler's lineage): hidden — charges dropped, gate open.
    branchA.chargeGuards(1.0);
    expect(() => branchA.enforceGuards()).not.toThrow();
    // Branch B: same object, unsuspended stack — charges land, gate trips.
    branchB.chargeGuards(1.0);
    expect(() => branchB.enforceGuards()).toThrow();
    branchA.endSuspension(token);
  });

  it("nested suspensions compose: the inner end must not unsuspend what the outer began", () => {
    const g = new TimeGuard(60000);
    const stack = new StateStack();
    stack.pushGuard(g);
    const outer = stack.beginSuspension([]);
    const inner = stack.beginSuspension([]);
    stack.endSuspension(inner);
    // Still suspended: the outer bracket is open.
    g.resume(stack);
    expect((g as any).state).toBe("paused");
    stack.endSuspension(outer);
    g.resume(stack);
    expect((g as any).state).toBe("running");
    stack.popGuard();
  });

  it("guardsHiddenFrom hides exactly the guards not live at registration", () => {
    const before = new CostGuard(1);
    const after = new CostGuard(1);
    const stack = new StateStack();
    stack.pushGuard(before);
    const entry = { fn: async () => undefined, liveGuardIds: [before.guardId] };
    stack.pushGuard(after);
    const hidden = stack.guardsHiddenFrom(entry);
    expect(hidden.map((g) => g.guardId)).toEqual([after.guardId]);
  });
});

describe("detectTrippedGuard — the one suspension-aware walk", () => {
  it("a suspended over-budget CostGuard does not report its trip; unsuspended it does", () => {
    // Pins the review finding on PR #558: Runner.shouldSkip used to run
    // its own check() walk without consulting suspendedGuardIds, so a
    // suspended over-budget cost guard could throw its trip out of the
    // very handler that suspended it. Both shouldSkip and enforceGuards
    // now route through this walk.
    const g = new CostGuard(0.5);
    const stack = new StateStack();
    stack.pushGuard(g);
    stack.chargeGuards(1.0);                       // over budget
    expect(stack.detectTrippedGuard()).not.toBeNull();

    const token = stack.beginSuspension([]);
    expect(stack.detectTrippedGuard()).toBeNull(); // invisible while suspended
    stack.endSuspension(token);
    expect(stack.detectTrippedGuard()).not.toBeNull();
  });
});
