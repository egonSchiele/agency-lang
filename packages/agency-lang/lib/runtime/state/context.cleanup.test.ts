import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";
import { TimeGuard } from "../guard.js";
import type { Clock, TimerHandle } from "../clock.js";

/** A clock that only records which timers are still pending. */
function countingClock(): Clock & { pending: number[] } {
  let next = 1;
  const pending: number[] = [];
  return {
    pending,
    now: () => 0,
    wallTime: () => 0,
    setTimer: (): TimerHandle => {
      const id = next++;
      pending.push(id);
      return { id };
    },
    clearTimer: (handle) => {
      const index = pending.indexOf(handle.id as number);
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

describe("RuntimeContext.cleanup", () => {
  it("clears the timer of a time guard still on the stack", () => {
    const clock = countingClock();
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
    expect(clock.pending.length).toBe(1);

    ctx.cleanup();

    expect(clock.pending).toEqual([]);
  });
});
