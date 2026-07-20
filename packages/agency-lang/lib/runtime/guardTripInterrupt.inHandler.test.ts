import { describe, it, expect } from "vitest";
import { TimeGuard, GuardExceededError } from "./guard.js";
import { raiseGuardTripsUntilClear } from "./guardTripInterrupt.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import type { HandlerEntry } from "./types.js";

const makeCtx = (): RuntimeContext<any> => {
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
  ctx.runId = "test-run";
  return ctx;
};

const entry = (): HandlerEntry => ({ fn: async () => undefined, liveGuardIds: [] });

/** A tripped single-member time scope on a marked stack, plus its error —
 *  the state a guard gate sees when a 5ms guard inside a handler is blown. */
function arrangeTrippedInHandler() {
  const ctx = makeCtx();
  const stack = new StateStack();
  const time = new TimeGuard(5);
  stack.pushGuard(time);
  time.scopeIds = [time.guardId];
  const err = new GuardExceededError("time", 5, 12, time.guardId, "in-handler");
  stack.executingHandlerEntries.push(entry());
  return { ctx, stack, time, err };
}

const guardTripKeys = (stack: StateStack): string[] =>
  Object.keys(stack.other).filter((k) => k.startsWith("__guardTrip_"));

describe("in-handler guard trips refuse to surface", () => {
  it("persisted open question: throws the trip error instead of re-surfacing", async () => {
    const { ctx, stack, time, err } = arrangeTrippedInHandler();
    const key = `__guardTrip_${time.guardId}#time@${time.currentLimit()}`;
    stack.other[key] = "stale-interrupt-id"; // open question, no recorded answer
    await expect(
      raiseGuardTripsUntilClear(ctx, stack, () => err),
    ).rejects.toBe(err);
    expect(guardTripKeys(stack)).toEqual([]); // stale key dropped, nothing new persisted
  });

  it("unanswered dispatch: throws the trip error, persists nothing, checkpoints nothing", async () => {
    const { ctx, stack, err } = arrangeTrippedInHandler();
    ctx.handlers = []; // nobody can answer
    // The stack is marked but there is deliberately no ALS scope: this is
    // the lost-ALS shape from the issue-616 investigation. The stack-read
    // refusal must hold on its own.
    await expect(
      raiseGuardTripsUntilClear(ctx, stack, () => err),
    ).rejects.toBe(err);
    expect(guardTripKeys(stack)).toEqual([]);
    expect(ctx.checkpoints.getSorted()).toEqual([]);
  });
});
