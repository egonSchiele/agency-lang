import { describe, it, expect } from "vitest";
import { _advanceTimeImpl } from "./builtins.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { FakeClock, type Clock } from "../runtime/clock.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

function makeCtx(clock?: Clock): RuntimeContext<any> {
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
