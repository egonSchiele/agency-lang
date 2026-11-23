import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";
import { TimeGuard } from "../guard.js";
import { FakeClock } from "../clock.js";

describe("RuntimeContext.cleanup", () => {
  it("clears the timer of a time guard still on the stack", () => {
    const clock = new FakeClock();
    const ctx = new RuntimeContext<any>({
      statelogConfig: {
        host: "https://example.com",
        apiKey: "k",
        projectId: "p",
        debugMode: false,
      },
      smoltalkDefaults: { model: "default-model" },
      dirname: "/tmp",
      clock,
    });
    const guard = new TimeGuard(60_000, undefined, clock);
    guard.isRootBudget = true;
    ctx.stateStack.pushGuard(guard);
    expect(clock.pendingTimerCount()).toBe(1);

    ctx.cleanup();

    expect(clock.pendingTimerCount()).toBe(0);
  });
});
