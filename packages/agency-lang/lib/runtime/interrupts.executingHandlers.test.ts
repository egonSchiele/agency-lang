import { describe, it as baseIt, expect } from "vitest";
import { gatherChainOutcome, interruptWithHandlers, isRejected } from "./interrupts.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import type { HandlerEntry } from "./types.js";
import type { Run } from "./asyncContext.js";
import { inFrameOf, withTestFrame } from "./__tests__/testHelpers.js";

// These tests call runtime functions that keep a value on the frame.
const it = withTestFrame(baseIt);

const makeCtx = (): RuntimeContext<any> =>
  new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });

describe("stack-carried handler execution mark", () => {
  it("throws when handlers are registered but no stack is passed", async () => {
    const ctx = makeCtx();
    ctx.handlers = [{ fn: async () => ({ type: "approve" as const }), liveGuardIds: [] }];
    // A run always carries a stack, so the missing stack is handed to the
    // chain walk directly.
    await expect(
      inFrameOf(ctx, new StateStack(), (run) =>
        gatherChainOutcome(
          run,
          { effect: "std::x", message: "m", data: {}, origin: "o" },
          undefined,
          "intr-1",
        ),
      ),
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
          return { type: "approve" as const };
        },
        liveGuardIds: [],
      },
    ];
    await inFrameOf(ctx, stack, (run) => interruptWithHandlers(run, "std::x", "m", {}, "o"));
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
      fn: async (run: Run, intr: any) => {
        if (intr.effect === "inner::raise") {
          selfHeard++;
          return { type: "approve" as const };
        }
        const verdict = await interruptWithHandlers(run, "inner::raise", "m", {}, "o");
        return { type: "approve" as const, value: verdict };
      },
      liveGuardIds: [],
    };
    const outer: HandlerEntry = {
      fn: async (_run: unknown, intr: any) => {
        if (intr.effect === "inner::raise") outerHeard++;
        return { type: "approve" as const };
      },
      liveGuardIds: [],
    };
    ctx.handlers = [outer, inner]; // chain walks last-registered first, so `inner` runs first
    await inFrameOf(ctx, stack, (run) => interruptWithHandlers(run, "kickoff", "m", {}, "o"));
    expect(selfHeard).toBe(0);
    expect(outerHeard).toBe(1);
  });

  it("an unanswered raise from inside a handler is refused as a rejection", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let refusal: any = null;
    ctx.handlers = [
      {
        fn: async (run: Run, intr: any) => {
          if (intr.effect === "kickoff") {
            refusal = await interruptWithHandlers(run, "nobody::answers", "m", {}, "o");
          }
          return { type: "approve" as const };
        },
        liveGuardIds: [],
      },
    ];
    await inFrameOf(ctx, stack, (run) => interruptWithHandlers(run, "kickoff", "m", {}, "o"));
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
          return { type: "approve" as const }; // handler returns while the straggler still runs
        },
        liveGuardIds: [],
      },
    ];
    await inFrameOf(ctx, stack, (run) => interruptWithHandlers(run, "kickoff", "m", {}, "o"));
    expect(markAtStragglerEnd).toBe(1); // straggler finished BEFORE the pop
    expect(stack.executingHandlerEntries).toEqual([]);
  });

  it("handler exit does not await promises launched before the handler began", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let preSettled = false;
    ctx.pendingPromises.add(
      new Promise<void>((r) =>
        setTimeout(() => {
          preSettled = true;
          r();
        }, 30),
      ),
    );
    ctx.handlers = [{ fn: async () => ({ type: "approve" as const }), liveGuardIds: [] }];
    await inFrameOf(ctx, stack, (run) => interruptWithHandlers(run, "kickoff", "m", {}, "o"));
    expect(preSettled).toBe(false); // the deadlock-shaped promise was left alone
  });
});
