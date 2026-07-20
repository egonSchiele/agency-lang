import { describe, it, expect } from "vitest";
import { interruptWithHandlers, isRejected } from "./interrupts.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import type { HandlerEntry } from "./types.js";

const makeCtx = (): RuntimeContext<any> =>
  new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });

describe("stack-carried handler execution mark", () => {
  it("throws when handlers are registered but no stack is passed", async () => {
    const ctx = makeCtx();
    ctx.handlers = [{ fn: async () => ({ type: "approve" }), liveGuardIds: [] }];
    await expect(
      interruptWithHandlers("std::x", "m", {}, "o", ctx, undefined),
    ).rejects.toThrow(/no StateStack/);
  });

  it("marks the stack for the duration of a handler body", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let seenDuring = -1;
    ctx.handlers = [
      {
        fn: async () => {
          seenDuring = stack.executingHandlerEntries.length;
          return { type: "approve" };
        },
        liveGuardIds: [],
      },
    ];
    await interruptWithHandlers("std::x", "m", {}, "o", ctx, stack);
    expect(seenDuring).toBe(1);
    expect(stack.executingHandlerEntries).toEqual([]);
  });

  // Exclusion is decided by the executingHandlers ALS, not the stack
  // mark; this pins that the carrier work did not disturb it.
  it("a handler never hears a raise made from its own body", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let selfHeard = 0;
    let outerHeard = 0;
    const inner: HandlerEntry = {
      fn: async (intr: any) => {
        if (intr.effect === "inner::raise") {
          selfHeard++;
          return { type: "approve" };
        }
        const verdict = await interruptWithHandlers("inner::raise", "m", {}, "o", ctx, stack);
        return { type: "approve", value: verdict };
      },
      liveGuardIds: [],
    };
    const outer: HandlerEntry = {
      fn: async (intr: any) => {
        if (intr.effect === "inner::raise") outerHeard++;
        return { type: "approve" };
      },
      liveGuardIds: [],
    };
    ctx.handlers = [outer, inner]; // chain walks last-registered first, so `inner` runs first
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(selfHeard).toBe(0);
    expect(outerHeard).toBe(1);
  });

  it("an unanswered raise from inside a handler is refused as a rejection", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let refusal: any = null;
    ctx.handlers = [
      {
        fn: async (intr: any) => {
          if (intr.effect === "kickoff") {
            refusal = await interruptWithHandlers("nobody::answers", "m", {}, "o", ctx, stack);
          }
          return { type: "approve" };
        },
        liveGuardIds: [],
      },
    ];
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(isRejected(refusal)).toBe(true);
    expect(refusal.value).toMatch(/inside a handler/);
  });

  it("handler exit awaits promises the handler launched, while the mark is still set", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let markAtStragglerEnd = -1;
    ctx.handlers = [
      {
        fn: async () => {
          ctx.pendingPromises.add(
            (async () => {
              await new Promise((r) => setTimeout(r, 10));
              markAtStragglerEnd = stack.executingHandlerEntries.length;
            })(),
          );
          return { type: "approve" }; // handler returns while the straggler still runs
        },
        liveGuardIds: [],
      },
    ];
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(markAtStragglerEnd).toBe(1); // straggler finished BEFORE the pop
    expect(stack.executingHandlerEntries).toEqual([]);
  });

  it("handler exit does not await promises launched before the handler began", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let preSettled = false;
    ctx.pendingPromises.add(
      new Promise<void>((r) => setTimeout(() => { preSettled = true; r(); }, 30)),
    );
    ctx.handlers = [{ fn: async () => ({ type: "approve" }), liveGuardIds: [] }];
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(preSettled).toBe(false); // the deadlock-shaped promise was left alone
  });
});
