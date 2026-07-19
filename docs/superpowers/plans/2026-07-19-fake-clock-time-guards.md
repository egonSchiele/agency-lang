# Fake clock for time-guard tests (#575) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let time-guard test fixtures advance a fake clock with a function call instead of burning real CPU in `spin()` loops, so the tests are fast and machine-independent.

**Architecture:** Introduce a `Clock` abstraction on the runtime context. `TimeGuard` reads time and arms its timer through that clock instead of the global `performance.now`/`setTimeout`. The real clock is the default. A test fixture that opts in gets a `FakeClock`, and a test-only stdlib seam `_advanceTime(ms)` moves it forward, firing any guard timer that comes due.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), Agency stdlib (`stdlib/*.agency`), the Agency execution test runner (`lib/cli/`), vitest for unit tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-fake-clock-time-guards-design.md`. Read it before starting.
- Default behavior must not change. The real clock is the default; a run only gets a `FakeClock` when explicitly asked.
- Use types, not interfaces. Use arrays, not sets. Use objects, not maps. No dynamic imports. (Repo coding standards.)
- `_advanceTime` is a test-only seam: a non-exported `def`, reached via `import test`, backed by a TypeScript helper. It follows the existing `_installSlowInput` precedent in `stdlib/thread.agency:205`.
- Build after any stdlib change: run `make` (not `pnpm run build`, which skips `lib/agents` and the stdlib compile). For a single stdlib file during iteration, `pnpm run compile stdlib/date.agency --force` (the `--force` is required; the incremental manifest silently skips an unchanged-mtime recompile).
- Commit message bodies and PR descriptions go in a file passed to `git`, never inline (apostrophe escaping breaks the shell). End commit messages with the `Co-Authored-By` trailer.
- Save test output to a file; do not re-run the slow agency suite to see failures.

---

## File Structure

- `lib/runtime/clock.ts` — **new**. The `Clock` type, `realClock`, `FakeClock`. Pure, no runtime dependencies. One responsibility: model time and timers behind a swappable seam.
- `lib/runtime/state/context.ts` — **modify**. `RuntimeContext` gains a `clock` field, set from an explicit constructor arg, else from the `AGENCY_FAKE_CLOCK` env var, else `realClock`.
- `lib/runtime/guard.ts` — **modify**. `TimeGuard`'s six time reads, one `setTimeout`, and one `clearTimeout` route through a private `clock()` helper.
- `lib/stdlib/builtins.ts` — **modify**. Add `_advanceTimeImpl`, the TypeScript helper behind the seam, next to `_installSlowInputImpl`.
- `stdlib/date.agency` — **modify**. Add the non-exported `_advanceTime` def.
- `lib/cli/util.ts` — **modify**. `executeNodeAsync` accepts `fakeClock` and sets `AGENCY_FAKE_CLOCK=1`.
- `lib/cli/test.ts` — **modify**. `TestCase` gains `fakeClock?: boolean`, threaded into the `executeNodeAsync` call.
- The migrated fixtures under `tests/agency/`.

---

## Task 0: Audit time reads outside the guard

The seam controls the six reads in `guard.ts`. Other subsystems read time independently and will NOT be faked (per-branch working-time budgets from #549/#550, statelog timestamps). This task confirms none of the fixtures we plan to migrate assert on those, so the migration cannot silently mislead.

**Files:**
- No code changes. Produces a note appended to the plan's PR description.

- [ ] **Step 1: Grep every wall/monotonic read in the runtime and state layers**

Run:
```bash
cd packages/agency-lang
grep -rn "performance.now()\|Date.now()" lib/runtime lib/stdlib | grep -v "\.test\." > /tmp/time-reads.txt
cat /tmp/time-reads.txt
```
Expected: a list including `guard.ts` (the six we route), plus others such as `ipc.ts`, `prompt.ts`, `runBatch.ts`, `interrupts.ts`, `ui.ts`, `statelog`.

- [ ] **Step 2: For each fixture slated for migration, confirm its asserted output does not depend on a non-guard time read**

The fixtures to migrate (Task 6) are `tests/agency/supervise/supervise.agency`, the `tests/agency/subprocess/nested-pause-*` fixtures, and the `tests/agency/guards/*` time fixtures. For each, read its `.test.json` `expectedOutput`. Confirm the expected value is a guard trip result (a `Result`, a salvaged draft, a decision string), not a logged duration or a wall-clock timestamp.

Run, for example:
```bash
grep -l "spin(" tests/agency/supervise/*.agency tests/agency/subprocess/*.agency tests/agency/guards/*.agency
```

- [ ] **Step 3: Write the cleared-list to a committed file**

Task 6 migrates exactly the fixtures this audit clears, so the list must be durable, not a PR-description note that vanishes on merge. Write it to `docs/superpowers/plans/2026-07-19-fake-clock-migration-list.md`:
- a `## Cleared for migration` section: one line per fixture, with the guard-trip value it asserts on (a `Result`, a salvaged draft, a decision string).
- a `## Not migrated` section: any fixture whose `expectedOutput` depends on a non-guard time read (a logged duration, a wall-clock timestamp), with the reason. These stay on the real clock.

- [ ] **Step 4: Commit the list**

```bash
git add docs/superpowers/plans/2026-07-19-fake-clock-migration-list.md
git commit -F <message-file>
```
Message subject: `Audit: which time-guard fixtures are safe to fake-clock`

This file is the input Task 6 Step 4 reads by name. A fixture in `## Not migrated` must not be converted.

---

## Task 1: The clock seam

**Files:**
- Create: `lib/runtime/clock.ts`
- Test: `lib/runtime/clock.test.ts`

**Interfaces:**
- Produces:
  - `type TimerHandle = { id: number }`
  - `type Clock = { now(): number; wallTime(): number; setTimer(fn: () => void, delayMs: number): TimerHandle; clearTimer(handle: TimerHandle): void }`
  - `const realClock: Clock`
  - `class FakeClock implements Clock` with an extra method `advance(ms: number): void`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/clock.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeClock, realClock } from "./clock.js";

describe("FakeClock", () => {
  it("starts at zero and advances now() and wallTime() together", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);
    expect(clock.wallTime()).toBe(0);
    clock.advance(200);
    expect(clock.now()).toBe(200);
    expect(clock.wallTime()).toBe(200);
  });

  it("fires a timer whose due time falls within the advance", () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimer(() => { fired = true; }, 100);
    clock.advance(50);
    expect(fired).toBe(false);
    clock.advance(60); // now at 110, past the 100ms timer
    expect(fired).toBe(true);
  });

  it("fires a timer due exactly at the advance target (dueAt === target boundary)", () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimer(() => { fired = true; }, 100);
    clock.advance(100); // lands exactly on the due time
    expect(fired).toBe(true);
  });

  it("does not fire a timer that was cleared", () => {
    const clock = new FakeClock();
    let fired = false;
    const handle = clock.setTimer(() => { fired = true; }, 100);
    clock.clearTimer(handle);
    clock.advance(200);
    expect(fired).toBe(false);
  });

  it("fires multiple distinct timers due within one advance, in due order", () => {
    const clock = new FakeClock();
    const order: number[] = [];
    clock.setTimer(() => order.push(2), 200);
    clock.setTimer(() => order.push(1), 100);
    clock.advance(300);
    expect(order).toEqual([1, 2]);
  });

  it("sets now() to each timer's due time before firing it", () => {
    const clock = new FakeClock();
    let seen = -1;
    clock.setTimer(() => { seen = clock.now(); }, 100);
    clock.advance(500);
    expect(seen).toBe(100); // not 500
  });

  it("terminates when a fired callback is a no-op (no re-arm)", () => {
    const clock = new FakeClock();
    let count = 0;
    clock.setTimer(() => { count++; }, 100);
    clock.advance(1000);
    expect(count).toBe(1);
    expect(clock.now()).toBe(1000);
  });

  it("fires a timer that a callback arms WITHIN the same advance span", () => {
    // Pins the re-entrancy invariant: advance() re-reads the pending list
    // after each firing, so a timer armed by a fired callback and due before
    // the target fires in the same advance() call. A one-shot snapshot loop
    // would silently break this.
    const clock = new FakeClock();
    let inner = false;
    clock.setTimer(() => {
      clock.setTimer(() => { inner = true; }, 50); // due at 100 + 50 = 150
    }, 100);
    clock.advance(300); // 150 <= 300, so the inner timer must fire too
    expect(inner).toBe(true);
  });

  it("does NOT fire a timer a callback arms beyond the advance target", () => {
    const clock = new FakeClock();
    let inner = false;
    clock.setTimer(() => {
      clock.setTimer(() => { inner = true; }, 500); // due at 100 + 500 = 600
    }, 100);
    clock.advance(300); // 600 > 300, so the inner timer must NOT fire
    expect(inner).toBe(false);
  });
});

describe("realClock", () => {
  afterEach(() => vi.useRealTimers());
  it("delegates to global timers", () => {
    vi.useFakeTimers();
    let fired = false;
    const handle = realClock.setTimer(() => { fired = true; }, 100);
    vi.advanceTimersByTime(50);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(60);
    expect(fired).toBe(true);
    realClock.clearTimer(handle); // no throw on an already-fired handle
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/runtime/clock.test.ts`
Expected: FAIL — `Cannot find module './clock.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/runtime/clock.ts`:
```ts
export type TimerHandle = { id: number };

/**
 * The seam every guard time read and timer goes through. The real clock is
 * the default; tests swap in a FakeClock to advance time deterministically.
 * See docs/superpowers/specs/2026-07-19-fake-clock-time-guards-design.md.
 */
export type Clock = {
  /** Monotonic milliseconds. What a time guard meters against. */
  now(): number;
  /** Milliseconds since the Unix epoch. What std::date reads. Unused today;
   *  here so issue #609 can reroute std::date through this seam later. */
  wallTime(): number;
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
};

export const realClock: Clock = {
  now: () => performance.now(),
  wallTime: () => Date.now(),
  setTimer: (fn, delayMs) => ({
    id: setTimeout(fn, delayMs) as unknown as number,
  }),
  clearTimer: (handle) => clearTimeout(handle.id),
};

export class FakeClock implements Clock {
  private monotonicMs = 0;
  // Base for wall time. Zero for now, so a frozen calendar reads as 1970.
  // Nothing calls wallTime() in this feature, so it does not matter yet. When
  // #609 wires std::date through the seam, seed this from a realistic epoch so
  // a test reading "today" does not get 1970. Known follow-up, not a bug here.
  private wallBaseMs = 0;
  private timers: { dueAt: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.monotonicMs;
  }

  wallTime(): number {
    return this.wallBaseMs + this.monotonicMs;
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ dueAt: this.monotonicMs + delayMs, fn, id });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  /**
   * Move the clock forward `ms` and fire every timer due within that span.
   * Terminates: nothing here arms a timer, and each iteration removes one, so
   * the pending list strictly shrinks. A guard timer's callback only aborts;
   * it never re-arms (re-arming is startWindow, which runs at a later runner
   * step), so there is no runaway and no firing cap.
   */
  advance(ms: number): void {
    const target = this.monotonicMs + ms;
    while (true) {
      // The earliest timer still due within the span. Re-computed each pass,
      // because a fired callback may have armed a new one.
      const due = this.earliestDueBy(target);
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.monotonicMs = due.dueAt; // step to the timer, then fire it
      due.fn();
    }
    this.monotonicMs = target;
  }

  private earliestDueBy(
    target: number,
  ): { dueAt: number; fn: () => void; id: number } | undefined {
    return this.timers.reduce<
      { dueAt: number; fn: () => void; id: number } | undefined
    >((earliest, t) => {
      if (t.dueAt > target) return earliest;
      if (!earliest || t.dueAt < earliest.dueAt) return t;
      return earliest;
    }, undefined);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/runtime/clock.test.ts`
Expected: PASS — all FakeClock cases (including the two re-entrancy cases and the boundary case) and the realClock case.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/clock.ts lib/runtime/clock.test.ts
git commit -F <message-file>
```
Message subject: `Add the Clock seam: realClock and FakeClock`

---

## Task 2: RuntimeContext carries a clock

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Test: `lib/runtime/state/context.clock.test.ts` (new)

**Interfaces:**
- Consumes: `Clock`, `realClock`, `FakeClock` from Task 1.
- Produces: `RuntimeContext` has a public `clock: Clock` field. The constructor arg object accepts an optional `clock?: Clock`.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/state/context.clock.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { RuntimeContext } from "./context.js";
import { FakeClock, realClock } from "../clock.js";

function makeCtx(clock?: import("../clock.js").Clock): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
    clock,
  });
}

describe("RuntimeContext.clock", () => {
  const saved = process.env.AGENCY_FAKE_CLOCK;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENCY_FAKE_CLOCK;
    else process.env.AGENCY_FAKE_CLOCK = saved;
  });

  it("defaults to the real clock", () => {
    delete process.env.AGENCY_FAKE_CLOCK;
    expect(makeCtx().clock).toBe(realClock);
  });

  it("installs a FakeClock when AGENCY_FAKE_CLOCK is set", () => {
    process.env.AGENCY_FAKE_CLOCK = "1";
    expect(makeCtx().clock).toBeInstanceOf(FakeClock);
  });

  it("an explicit clock arg wins over the env var", () => {
    process.env.AGENCY_FAKE_CLOCK = "1";
    const explicit = new FakeClock();
    expect(makeCtx(explicit).clock).toBe(explicit);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/runtime/state/context.clock.test.ts`
Expected: FAIL — `clock` is not a property on `RuntimeContext`, and the constructor arg is unknown.

- [ ] **Step 3: Add the field and constructor wiring**

In `lib/runtime/state/context.ts`:

Add the import near the other runtime imports at the top:
```ts
import { Clock, realClock, FakeClock } from "../clock.js";
```

Add a small module-level helper above the class. It holds the "how" of picking a default clock (the env read plus instantiation), so the constructor body reads declaratively:
```ts
/** The default clock for a run: a FakeClock only when a test opts in via the
 *  AGENCY_FAKE_CLOCK env var, otherwise the real clock. The env var is set by
 *  the test runner per test case (see lib/cli/util.ts). */
function defaultClock(): Clock {
  return process.env.AGENCY_FAKE_CLOCK ? new FakeClock() : realClock;
}
```

Add a public field alongside the other public fields (near `handlers`, around line 255's neighbors in the field block that begins near line 80):
```ts
  /** The time source for guards. Real by default; a FakeClock only when a
   *  test opts in. NOT serialized — reconstructed per run, like handlers. */
  clock: Clock;
```

Add `clock?: Clock;` to the constructor's args object type (the block starting at line 208, next to `logLevel?`). This arg is a TEST-ONLY seam: unit tests pass a `FakeClock` directly. It is never supplied in production — production runs get their clock from `defaultClock()`, i.e. the env var or the real default. Do not look for a production call site that passes it; there isn't one.
```ts
    logLevel?: LogLevel;
    /** Test-only override. Omitted in production, where defaultClock()
     *  (the env var or the realClock default) applies. */
    clock?: Clock;
```

Set the field in the constructor body, after the `applyRuntimeConfigOverridesToContextArgs` calls (an explicit arg wins, else the default):
```ts
    this.clock = args.clock ?? defaultClock();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/runtime/state/context.clock.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no serialization regression**

`RuntimeContext` is reconstructed per run and not part of checkpoint state (like `handlers`). Confirm nothing serializes it:
```bash
grep -n "clock" lib/runtime/state/context.ts | grep -i "toJSON\|serialize\|JSON.stringify"
```
Expected: no output (the clock is never serialized).

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/state/context.ts lib/runtime/state/context.clock.test.ts
git commit -F <message-file>
```
Message subject: `RuntimeContext carries a swappable clock`

---

## Task 3: Route TimeGuard through the clock

**Files:**
- Modify: `lib/runtime/guard.ts`
- Test: `lib/runtime/guard.clock.test.ts` (new)

**Interfaces:**
- Consumes: `RuntimeContext.clock` (Task 2), `FakeClock` (Task 1), `runInTestContext` from `lib/runtime/asyncContext.ts`.
- Produces: no new exports. `TimeGuard` now meters against `getRuntimeContext().ctx.clock` when a frame is present.

**Background for the implementer:** `TimeGuard` today calls the global `performance.now()` in six places (lines 596, 638, 729, 761, 873, 893), arms an abort timer with `setTimeout` (line 866), and cancels it with `clearTimeout` (line 899). We route all of these through a `clock()` helper. Outside an execution frame — a guard revived from a checkpoint — there is no context, so the helper falls back to `realClock`. That preserves today's behavior: a revived guard with no frame meters against real time.

The existing `TimeGuard` unit tests in `lib/runtime/guard.test.ts` use `vi.useFakeTimers()`. They keep passing unchanged, because `realClock` delegates to the same global `setTimeout`/`performance.now` that vitest mocks.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/guard.clock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TimeGuard } from "./guard.js";
import { StateStack } from "./state/stateStack.js";
import { RuntimeContext } from "./state/context.js";
import { FakeClock } from "./clock.js";
import { runInTestContext } from "./asyncContext.js";
import { ThreadStore } from "./state/threadStore.js";

function ctxWithFakeClock(clock: FakeClock): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
    clock,
  });
}

describe("TimeGuard reads the context clock", () => {
  it("trips on a fake-clock advance, and reports fake-clock spent (not a real-time delta)", () => {
    const clock = new FakeClock();
    const ctx = ctxWithFakeClock(clock);
    const threads = new ThreadStore();

    runInTestContext(ctx, ctx.stateStack, threads, () => {
      const stack = ctx.stateStack;
      const guard = new TimeGuard(100);
      stack.pushGuard(guard);
      expect(guard.check(stack)).toBeNull(); // not yet over budget

      clock.advance(200); // fake time only; no real ms elapse

      const err = guard.check(stack);
      expect(err).not.toBeNull();
      // The load-bearing assertion. `spent` flows from currentElapsed() ->
      // now(). If any of the six now() reads is NOT routed through the seam,
      // spent becomes a huge real-millisecond number and this fails. Asserting
      // only non-null would pass even then, because the routed TIMER already
      // set `tripped` and check() short-circuits the OR.
      expect(err!.spent).toBeCloseTo(200, 0);
      expect(guard.isTripped()).toBe(true);
    });
  });

  it("does not trip under budget, and reports the fake-clock elapsed", () => {
    const clock = new FakeClock();
    const ctx = ctxWithFakeClock(clock);
    const threads = new ThreadStore();

    runInTestContext(ctx, ctx.stateStack, threads, () => {
      const stack = ctx.stateStack;
      const guard = new TimeGuard(100);
      stack.pushGuard(guard);
      clock.advance(50);
      expect(guard.check(stack)).toBeNull();
      expect(guard.isTripped()).toBe(false);
    });
  });

  it("two guards with different limits both meter against one advanced clock", () => {
    // This is where the nested-fixture migration risk lives (Task 6 Step 4):
    // one advance() fires every due timer, so an inner and an outer guard can
    // both trip in a single advance, which a real spin() run would not do
    // (the inner trip would abort before the outer limit is reached). Pin the
    // behavior at the guard level so Task 6 conversions have a reference.
    const clock = new FakeClock();
    const ctx = ctxWithFakeClock(clock);
    const threads = new ThreadStore();

    runInTestContext(ctx, ctx.stateStack, threads, () => {
      const stack = ctx.stateStack;
      const outer = new TimeGuard(100);
      stack.pushGuard(outer);
      const inner = new TimeGuard(50);
      stack.pushGuard(inner);

      clock.advance(200); // past BOTH limits in one call

      const innerErr = inner.check(stack);
      expect(innerErr).not.toBeNull();
      expect(innerErr!.spent).toBeCloseTo(200, 0);
      const outerErr = outer.check(stack);
      expect(outerErr).not.toBeNull();
    });
  });
});
```

Note for the implementer: verify the import paths for `StateStack`, `ThreadStore`, and the `TimeGuard(limit)` constructor arity against the current source before running — adjust the imports if a path differs. `pushGuard`/`check`/`isTripped` are the driving API, and `check()` returns a `GuardExceededError` carrying `spent` (see the existing `guard.test.ts`, which asserts `.spent` at lines 92/106/121/178/193, for the same pattern under `vi.useFakeTimers`). Note also the once-only consume flag on `TimeGuard`: the second `check()` after a trip returns null, so within one test call `check()` a tripped guard only once when you need the error.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/runtime/guard.clock.test.ts`
Expected: FAIL — the guard still reads the global `performance.now()`, so advancing the FakeClock does not move the time it meters against, and it never trips.

- [ ] **Step 3: Add the clock() helper and route the reads**

In `lib/runtime/guard.ts`:

Add imports at the top with the other runtime imports:
```ts
import { Clock, realClock, TimerHandle } from "./clock.js";
import { __ctx } from "./asyncContext.js";
```

`__ctx()` is the canonical lax context accessor (`asyncContext.ts`): it returns `agencyStore.getStore()?.ctx`, or `undefined` outside a frame. Use it rather than re-inlining `agencyStore.getStore()?.ctx`, so this access does not become a second copy that can drift (the same duplication class as the LSP prelude-drift bug). Do NOT reach for `agency.ctxMaybe()` here even though it is the "official" lax accessor — `agency.ts` imports `TimeGuard` from `guard.ts`, so importing `agency` back into `guard.ts` is a circular import. `__ctx` lives in `asyncContext.ts`, which `guard.ts` can import freely.

Add a private helper on the `TimeGuard` class (place it near the other private methods, e.g. just above `startWindow`):
```ts
  /** The time source. Reads the run's clock when a frame is present; a
   *  guard revived from a checkpoint runs frameless and meters against the
   *  real clock, exactly as before this seam existed. */
  private clock(): Clock {
    return __ctx()?.clock ?? realClock;
  }
```

Replace each of the six `performance.now()` calls inside `TimeGuard` (lines 596, 638, 729, 761, 873, 893) with `this.clock().now()`. Example, line 893:
```ts
    this.windowStart = this.clock().now();
```
And inside the timer callback, line 873:
```ts
        const spent = this.elapsedMs +
          (this.windowStart !== undefined
            ? this.clock().now() - this.windowStart
            : 0);
```

Replace the timer arming (line 866):
```ts
    this.timerHandle = this.clock().setTimer(() => {
      // ... unchanged callback body ...
    }, delay);
```

Replace the cancellation (line 899):
```ts
      this.clock().clearTimer(this.timerHandle);
```

Note: `this.timerHandle`'s type changes from `ReturnType<typeof setTimeout>` to `TimerHandle | undefined`. Update its field declaration (near line 533) to `private timerHandle: TimerHandle | undefined = undefined;` (`TimerHandle` is already imported from `./clock.js` in the import line above).

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm exec vitest run lib/runtime/guard.clock.test.ts`
Expected: PASS — the guard trips on fake-clock advance.

- [ ] **Step 5: Run the existing guard tests to verify no regression AND the frameless fallback**

Run: `pnpm exec vitest run lib/runtime/guard.test.ts`
Expected: PASS. This step does double duty. First, the `vi.useFakeTimers()` tests still work, because `realClock` delegates to the mocked globals. Second — and this is the intended coverage of the revive-with-no-frame case — every test in `guard.test.ts` runs OUTSIDE `runInTestContext`, so `__ctx()` returns `undefined` and `clock()` falls back to `realClock`. If the fallback threw instead of returning `realClock`, every one of these tests would crash. So a green `guard.test.ts` is the proof that a frameless guard meters against the real clock. Do not treat this as an incidental pass; it is the frameless-fallback test.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: clean (confirms the `timerHandle` type change is consistent).

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/guard.ts lib/runtime/guard.clock.test.ts
git commit -F <message-file>
```
Message subject: `Route TimeGuard time reads through the context clock`

---

## Task 4: The `_advanceTime` seam

**Files:**
- Modify: `lib/stdlib/builtins.ts`
- Modify: `stdlib/date.agency`
- Test: `lib/stdlib/builtins.clock.test.ts` (new)

**Interfaces:**
- Consumes: `FakeClock` (Task 1), `RuntimeContext.clock` (Task 2), `getRuntimeContext` from `lib/runtime/asyncContext.ts`.
- Produces:
  - `export function _advanceTimeImpl(ms: number): void` in `lib/stdlib/builtins.ts`.
  - A non-exported `def _advanceTime(ms: number)` in `stdlib/date.agency`.

- [ ] **Step 1: Write the failing test for the TypeScript helper**

Create `lib/stdlib/builtins.clock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { _advanceTimeImpl } from "./builtins.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { FakeClock } from "../runtime/clock.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

function makeCtx(clock?: import("../runtime/clock.js").Clock): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
    clock,
  });
}

describe("_advanceTimeImpl", () => {
  it("advances the run's FakeClock", () => {
    const clock = new FakeClock();
    const ctx = makeCtx(clock);
    runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () => {
      _advanceTimeImpl(250);
      expect(clock.now()).toBe(250);
    });
  });

  it("throws a clear error when the clock is not fake", () => {
    const ctx = makeCtx(); // real clock
    runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () => {
      expect(() => _advanceTimeImpl(250)).toThrow(/fake clock/i);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/builtins.clock.test.ts`
Expected: FAIL — `_advanceTimeImpl` is not exported.

- [ ] **Step 3: Implement the TypeScript helper**

In `lib/stdlib/builtins.ts`, add near `_installSlowInputImpl` (around line 133). Add the import at the top if not present:
```ts
import { FakeClock } from "../runtime/clock.js";
```
Then:
```ts
/** Test-only: advance the run's fake clock by `ms`, firing any guard timer
 *  that comes due. Exposed to fixtures as the non-exported `_advanceTime`
 *  def in `stdlib/date.agency` (test imports only). Throws if the run holds
 *  the real clock, so a stray call outside a fake-clock test fails loudly
 *  rather than doing nothing. */
export function _advanceTimeImpl(ms: number): void {
  const { ctx } = getRuntimeContext();
  if (!(ctx.clock instanceof FakeClock)) {
    throw new Error(
      '_advanceTime() needs a fake clock. Set "fakeClock": true on this test case.',
    );
  }
  ctx.clock.advance(ms);
}
```

Deliberate design note (do not "fix" this in review): `advance` lives on `FakeClock` only, not on the `Clock` type, so this helper branches on the concrete type with `instanceof`. The alternative — putting `advance(ms)` on the `Clock` interface and giving `realClock.advance` a throwing body — would drop the `instanceof` but widen the *production* `Clock` interface with a test-only verb. We keep `advance` off the production interface on purpose. The `instanceof` is confined to this one test-only helper and never runs on a production path, so the leak is acceptable and bounded. This is the one spot in the design that sits against the "dispatch through the interface" preference, and it is a conscious trade, not an oversight.

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `pnpm exec vitest run lib/stdlib/builtins.clock.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the Agency-facing seam**

In `stdlib/date.agency`, add a non-exported def (mirror the `_installSlowInput` shape in `stdlib/thread.agency:205`). First, add the import of the helper at the top of `date.agency` alongside its other `agency-lang/stdlib-lib/...` imports (verify the exact module specifier used by the file's existing builtins import; `_installSlowInput` uses `agency-lang/stdlib-lib/builtins.js`):
```agency
import { _advanceTimeImpl } from "agency-lang/stdlib-lib/builtins.js"
```
Then the def:
```agency
/** Test-only seam (import test { _advanceTime }): advance the fake clock so a
time guard trips without spending real time. Only works under a test case with
"fakeClock": true; throws otherwise. */
def _advanceTime(ms: number) {
  """
  Test-only: move the fake clock forward `ms` milliseconds, tripping any time
  guard whose budget is now exceeded.

  @param ms - How many milliseconds of fake time to advance.
  """
  _advanceTimeImpl(ms)
}
```

- [ ] **Step 6: Build the stdlib and confirm it compiles**

Run:
```bash
pnpm run compile stdlib/date.agency --force
```
Expected: `stdlib/date.agency → stdlib/date.js` with no error. (The `--force` is mandatory; without it the manifest may skip the recompile.)

- [ ] **Step 7: Commit**

```bash
git add lib/stdlib/builtins.ts lib/stdlib/builtins.clock.test.ts stdlib/date.agency stdlib/date.js
git commit -F <message-file>
```
Message subject: `Add the _advanceTime test seam in std::date`

---

## Task 5: Wire `fakeClock` through the test runner

**Files:**
- Modify: `lib/cli/util.ts`
- Modify: `lib/cli/test.ts`
- Test: `tests/agency/guards/fake-clock-trip.agency` + `.test.json` (new fixture, doubles as the end-to-end proof)

**Interfaces:**
- Consumes: the `AGENCY_FAKE_CLOCK` env contract from Task 2, the `_advanceTime` seam from Task 4.
- Produces: `TestCase.fakeClock?: boolean`; `executeNodeAsync` sets `AGENCY_FAKE_CLOCK=1` when asked.

- [ ] **Step 1: Write the failing end-to-end fixture**

Create `tests/agency/guards/fake-clock-trip.agency`:
```agency
import test { _advanceTime } from "std::date"

node tripsOnFakeAdvance(): string {
  const r = guard(time: 100ms) {
    _advanceTime(200)
    return "never reached"
  }
  if (isFailure(r)) { return "tripped" }
  return r.value
}

node doesNotTripUnderBudget(): string {
  const r = guard(time: 100ms) {
    _advanceTime(50)
    return "finished"
  }
  if (isFailure(r)) { return "tripped" }
  return r.value
}
```

Create `tests/agency/guards/fake-clock-trip.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "tripsOnFakeAdvance",
      "fakeClock": true,
      "input": "",
      "expectedOutput": "\"tripped\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "doesNotTripUnderBudget",
      "fakeClock": true,
      "input": "",
      "expectedOutput": "\"finished\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Run the fixture to verify it fails**

Run:
```bash
pnpm run agency test tests/agency/guards/fake-clock-trip.agency 2>&1 | tee /tmp/fakeclock.txt
```
Expected: FAIL. `fakeClock` is not yet wired, so no `FakeClock` is installed; `_advanceTimeImpl` sees the real clock and throws "needs a fake clock". (This confirms the seam's fail-loud behavior end to end before wiring.)

Read this red carefully: it fires because `_advanceTime` throws on the real clock, NOT because the trip interleaving is wrong. The trip path is only proven green at Step 6. So do not read a later Step 6 failure as "just the wiring" — Step 2's red does not exercise the trip at all.

- [ ] **Step 3: Add `fakeClock` to the TestCase type**

In `lib/cli/test.ts`, add to the `TestCase` type (the block starting at line 36, after `fetchMocks?`):
```ts
  // Install a deterministic fake clock for this test case. Guard fixtures use
  // it with the `_advanceTime` seam (import test from "std::date") to trip time
  // guards without spending real time. Off by default: the run keeps the real
  // clock. See docs/superpowers/specs/2026-07-19-fake-clock-time-guards-design.md.
  fakeClock?: boolean;
```

- [ ] **Step 4: Thread it into the executeNodeAsync call**

In `lib/cli/test.ts`, at the `executeNodeAsync({ ... })` call (around line 583), add the field alongside `llmMocks`:
```ts
      fakeClock: testCase.fakeClock,
```

- [ ] **Step 5: Accept and apply it in executeNodeAsync**

In `lib/cli/util.ts`:

Add `fakeClock?: boolean;` to the `ExecuteNodeArgs` type (near `useTestLLMProvider?` around line 214).

In the `executeNodeAsync` function (starting line 376), destructure it:
```ts
export async function executeNodeAsync({
  llmMocks,
  useTestLLMProvider,
  fetchMocks,
  fakeClock,
  ...rest
}: ExecuteNodeArgs): Promise<{ data: any; stdout: string; stderr: string }> {
```
Then set the env var after the `env` object is created (it is built around line 384; add this right after that block, independent of `useDeterministic`):
```ts
  if (fakeClock) {
    env.AGENCY_FAKE_CLOCK = "1";
  }
```

- [ ] **Step 6: Run the fixture to verify it passes**

Run:
```bash
pnpm run agency test tests/agency/guards/fake-clock-trip.agency 2>&1 | tee /tmp/fakeclock.txt
```
Expected: PASS, 2/2 tests. Both complete near-instantly (no real 100ms waits).

- [ ] **Step 7: Verify the opt-out — a fixture without the flag keeps the real clock**

Add a third node to `fake-clock-trip.agency` and a matching test case WITHOUT `fakeClock`. The node returns the failure's error text, so the assertion can check the SPECIFIC message rather than "something went wrong":
```agency
node advanceWithoutFakeClockErrors(): string {
  const r = guard(time: 100ms) {
    _advanceTime(10)
    return "unreached"
  }
  if (isFailure(r)) { return r.error }
  return r.value
}
```
```json
    {
      "nodeName": "advanceWithoutFakeClockErrors",
      "input": "",
      "expectedOutput": "<PASTE the exact r.error string observed in Step 2>",
      "evaluationCriteria": [{ "type": "exact" }]
    }
```
Only `exact` and `llmJudge` are supported criteria (`lib/cli/test.ts:29,35`); there is no `contains`. So assert `exact` on the full error string. The message is deterministic — `_advanceTimeImpl` throws a fixed string, and this node has no other failure path (no llm, no other calls) — so an exact match is stable across runs and still specific to the fake-clock refusal, which is what the reviewer asked for. A generic `"tripped-or-errored"` token would stay green on any unrelated failure and is not acceptable for a fail-loud check.

Note for the implementer: you already have the exact error text. Step 2 ran this whole fixture with no `fakeClock` flag anywhere, so `_advanceTime` threw and the harness printed the resulting `r.error`. Copy that string verbatim into `expectedOutput`. If instead the throw crashed the node rather than surfacing as `isFailure(r)`, that is still an acceptable fail-loud outcome — assert `exact` on the node-error string the harness reports, and record the difference. The invariant to preserve: the assertion fails unless the specific fake-clock refusal fired.

- [ ] **Step 8: Commit**

```bash
git add lib/cli/util.ts lib/cli/test.ts tests/agency/guards/fake-clock-trip.agency tests/agency/guards/fake-clock-trip.test.json
git commit -F <message-file>
```
Message subject: `Wire fakeClock through the test runner`

---

## Task 6: Migrate the slow fixtures

**Files:**
- Modify: `tests/agency/supervise/supervise.agency` + `.test.json`
- Modify: the `tests/agency/subprocess/nested-pause-*` fixtures (only those Task 0 cleared)
- Modify: the `tests/agency/guards/*` time fixtures (only those Task 0 cleared)

**Interfaces:**
- Consumes: everything from Tasks 1–5.

**Background:** Each migration swaps a `spin(...)` that burns real CPU for an `_advanceTime(...)` that moves the fake clock, and adds `"fakeClock": true` to the affected test cases plus the `import test { _advanceTime } from "std::date"` line. Convert only fixtures whose slowness comes from spinning down a guard clock.

The load-bearing case is `overshootIsCoveredByTheGrant` in `supervise.agency`. Its correctness rests on a specific interleaving (traced in the spec): the block-body `_advanceTime` trips the guard once; the handler runs `slowCheck`, whose own `_advanceTime` fires no timer and only moves the clock; then `approve` re-arms and the block resumes. The regression it guards is `grant = nextInterval` in `stdlib/supervise.agency`.

- [ ] **Step 1: Convert `supervise.agency`**

Add the import at the top:
```agency
import test { _advanceTime } from "std::date"
```
First read the current fixture to see the exact spin values — they are not uniform. The `overshootIsCoveredByTheGrant` node and its `slowCheck` use `spin(3000000)` (three million); the other nodes use `spin(300000)` (three hundred thousand). Do not assume one value.

In `slowCheck`, replace `spin(3000000)` with `_advanceTime(500)`. In `overshootIsCoveredByTheGrant`'s block, replace `const s = spin(3000000)` with `_advanceTime(500)` and adjust the return so it does not reference `s` (return a literal, e.g. `return "done:spun"`; update the `.test.json` `expectedOutput` to match). Leave `every: 100ms` — do not use `every: 1ms` (the fake clock makes the interval choice free, and a larger interval keeps the trace simple).

Set `"fakeClock": true` on every test case in `supervise.test.json` that now calls `_advanceTime`. Read the other nodes in the file (`continueLetsBlockFinish`, `stopSalvagesDraft`, etc.), replace their `spin(300000)` calls with an `_advanceTime(...)` amount matched to that node's guard/`every` values, and give each `fakeClock: true`.

- [ ] **Step 2: Run supervise to verify it passes and is fast**

Run:
```bash
pnpm run compile stdlib/supervise.agency --force  # only if you touched stdlib; the fixture itself is not stdlib
time pnpm run agency test tests/agency/supervise/supervise.agency 2>&1 | tee /tmp/supervise.txt
```
Expected: all tests pass, in a few seconds rather than ~76.

- [ ] **Step 3: Prove the migrated overshoot test still catches the bug**

Temporarily revert the fix in the stdlib to reintroduce the regression:
```bash
cp stdlib/supervise.agency /tmp/supervise.agency.bak
# change: const grant = overshoot + nextInterval   ->   const grant = nextInterval
```
Apply the edit, then:
```bash
pnpm run compile stdlib/supervise.agency --force
grep -n "locals.grant = " stdlib/supervise.js   # MUST show the reverted form, or the manifest skipped the rebuild
pnpm run agency test tests/agency/supervise/supervise.agency 2>&1 | tee /tmp/supervise-buggy.txt
```
Expected: `overshootIsCoveredByTheGrant` FAILS with the guard-approval error. If it passes, the migration weakened the test — stop and fix (likely the advance amount is too small; increase it so the overshoot exceeds the next interval).

Then restore:
```bash
cp /tmp/supervise.agency.bak stdlib/supervise.agency
pnpm run compile stdlib/supervise.agency --force
grep -n "locals.grant = " stdlib/supervise.js   # MUST show overshoot + nextInterval again
```

- [ ] **Step 4: Convert the remaining fixtures — one at a time, NOT as a batch**

Convert exactly the fixtures on Task 0's committed cleared-list (`docs/superpowers/plans/2026-07-19-fake-clock-migration-list.md`), and no others. A fixture Task 0 flagged as asserting on a non-guard time value must NOT be migrated here — its assertion would read real time inside a fake-clock run and diverge.

This is the riskiest step in the whole plan, and it is not a rote find-and-replace. Two mechanics make each fixture its own small investigation:

**Hazard A — `_advanceTime` moves only the clock of the process it runs in.** The `nested-pause-*` fixtures are subprocess-IPC fixtures. The guard whose budget must expire may be armed in a *child* agency process, not the one where the old `spin()` ran. `AGENCY_FAKE_CLOCK=1` is inherited by every descendant on spawn, so each process has its own `FakeClock`, but a `_advanceTime` call advances only the clock of the process that executes it. A swap that moves the parent's clock while the guard lives in the child will simply never trip, and the test will hang or mis-assert.

**Hazard B — one `_advanceTime` fires every due timer at once.** `advance(ms)` fires all timers with `dueAt <= target`. For a single guard that is fine. But with nested or concurrent guards — an inner `guard(time: 50ms)` inside an outer `guard(time: 100ms)` — `_advanceTime(200)` sets *both* tripped flags in one synchronous call, before the runner observes either. A real `spin()` run would abort at the inner 50ms trip and never reach the outer limit; the fake clock reaches it anyway. This can change which guards trip and how many. (Task 3's "two guards" unit test pins this behavior at the guard level — use it as the reference for what the fixture will now see.)

Do this per fixture, as its own sub-step:

1. **Read the fixture and map its guards.** Write down, for each `spin(...)` you will replace: which `guard(time:)`/`supervise(every:)` budget it is meant to exceed, whether that guard is armed in this process or a spawned child, and whether any other guard is live at the same time.
2. **Place the `_advanceTime` call in the process that owns the target guard.** If the guard lives in a child, the `_advanceTime` must run in the child's code, not the parent's. Trace it the way `overshootIsCoveredByTheGrant` was traced in Step 1.
3. **Choose an advance amount that stops at the first expected trip**, if the original run would have stopped there. If a real run would have tripped only the inner guard, advance just past the inner limit (e.g. `_advanceTime(60)` for a 50ms inner), not past the outer. If the original genuinely reaches multiple trips, confirm the multi-trip outcome matches the original's asserted output.
4. **Add `fakeClock: true`** to the affected test cases, and the `import test { _advanceTime } from "std::date"` line.
5. **Run the one fixture and confirm it passes:**
   ```bash
   pnpm run agency test tests/agency/subprocess/nested-pause-user-guard.agency 2>&1 | tee /tmp/nested.txt
   ```
6. **If a fixture resists** — the trip won't fire from any single-process advance, or the multi-trip semantics can't be matched — do not force it. Leave that fixture on real time, note it in the commit message as "not migrated: <reason>", and move on. A fixture kept slow-but-correct beats a fixture made fast-but-wrong.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/supervise tests/agency/subprocess tests/agency/guards
git commit -F <message-file>
```
Message subject: `Migrate slow time-guard fixtures to the fake clock`

---

## Task 7: Full build and final checks

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `make`
Expected: completes without error (rebuilds stdlib and dist so the CLI uses the new seam).

- [ ] **Step 2: Run the affected unit suites once, saved to a file**

Run:
```bash
pnpm exec vitest run lib/runtime/clock.test.ts lib/runtime/state/context.clock.test.ts lib/runtime/guard.clock.test.ts lib/runtime/guard.test.ts lib/stdlib/builtins.clock.test.ts 2>&1 | tee /tmp/unit.txt
```
Expected: all pass.

- [ ] **Step 3: Typecheck**

Run: `pnpm run typecheck`
Expected: clean.

- [ ] **Step 4: Structural lint**

Run: `pnpm run lint:structure`
Expected: clean (catches banned patterns).

- [ ] **Step 5: Push and open the PR (only when asked)**

Do not push or open a PR until the owner asks. When asked, put the description in a file and include the Task 0 audit findings and the reverted-build regression evidence from Task 6 Step 3.

---

## Self-Review

**Spec coverage.** The spec's pieces map to tasks: clock seam → Task 1; clock on the context → Task 2; guard reads through the seam → Task 3; `_advanceTime` in `std::date` as a test seam → Task 4; per-test opt-in via `fakeClock` → Task 5; the out-of-scope blast-radius audit → Task 0; migration → Task 6. The spec's mandatory tests are covered: deterministic trip (Task 5 Step 1), the reverted-build regression (Task 6 Step 3), concurrent due timers (now at BOTH levels — raw timers in Task 1 and two `TimeGuard`s against one advanced clock in Task 3, since the plan-review flagged nested migration as the real risk), the opt-out (Task 5 Step 7, now asserting on the specific fake-clock message rather than a generic token), revive-with-no-frame (the `clock()` fallback, made an intentional named coverage point in Task 3 Step 5). The firing cap was removed from the spec; no task adds one, matching the spec.

**Fixed after plan review.** The Task 3 unit test now asserts `err.spent`, not just non-null, so an unrouted `now()` read fails it (a non-null-only assert passed on a half-routed guard, because the routed timer already sets `tripped` and short-circuits the trip OR). The `advance()` re-entrancy invariant now has two dedicated Task 1 cases (arm-within-span fires, arm-beyond-target does not), plus a `dueAt === target` boundary case. Task 6 Step 4 is expanded from a one-liner into a per-fixture procedure covering the two migration hazards the review named: `_advanceTime` moves only its own process's clock (subprocess fixtures), and one advance fires every due timer at once (nested guards). Task 0's cleared-list is now a committed file that Task 6 reads by name, not a PR-description note. The guard's `clock()` helper uses the canonical `__ctx()` accessor rather than re-inlining the store reach (avoiding drift), and the note explains why `agency.ctxMaybe()` is NOT used (import cycle: `agency.ts` imports `TimeGuard`). The `_advanceTimeImpl` `instanceof` is documented as a conscious trade against widening the production `Clock` interface. The `defaultClock()` helper replaces the constructor's nested ternary.

**Type consistency.** `Clock`, `TimerHandle`, `realClock`, `FakeClock`, and `FakeClock.advance(ms)` are defined in Task 1 and used unchanged in Tasks 2, 3, 4. `RuntimeContext.clock` (Task 2) is read as `ctx.clock` in Tasks 3 and 4. `_advanceTimeImpl(ms)` (Task 4) is the exact name the `_advanceTime` def calls. `fakeClock` is the same property name on `TestCase`, in the `executeNodeAsync` args, and the `AGENCY_FAKE_CLOCK` env var throughout.

**Known verification points handed to the implementer, not left vague.** The `timerHandle` type change (Task 3 Step 3) is typecheck-verified. The import paths in the new test files are flagged for confirmation against source. The no-fake-clock throw's exact surfaced shape (Task 5 Step 7) is called out to confirm rather than assumed. The manifest-skip trap on recompile is guarded with an explicit `grep` on the emitted `.js` (Task 6 Step 3).
