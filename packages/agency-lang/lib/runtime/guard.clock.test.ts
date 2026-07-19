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
