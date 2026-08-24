import { describe, it, expect } from "vitest";
import { throwIfNodeResultAborted } from "./abortBoundary.js";
import { AbortedResult } from "./abortedResult.js";
import { AgencyCancelledError, makeAbortCause, type AbortCause } from "./errors.js";
import { State } from "./state/stateStack.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";

function tripCause(): AbortCause {
  return makeAbortCause({
    kind: "guardTrip",
    dimension: "cost",
    limit: 1,
    spent: 2,
    guardId: "g1",
  });
}

/** Only the one method the boundary touches, plus a record of the calls. */
function stubCtx(): { ctx: RuntimeContext<GraphState>; closes: number } {
  const state = { closes: 0 };
  const ctx = {
    closeTraceWriter: async (): Promise<void> => {
      state.closes += 1;
    },
  } as unknown as RuntimeContext<GraphState>;
  return {
    ctx,
    get closes() {
      return state.closes;
    },
  };
}

function abortedNodeResult(): { data: AbortedResult } {
  return {
    data: AbortedResult.fromError(new AgencyCancelledError("trip", tripCause()), new State(), "n"),
  };
}

describe("throwIfNodeResultAborted", () => {
  it("passes an ordinary node result straight through", async () => {
    const { ctx } = stubCtx();
    await expect(
      throwIfNodeResultAborted({ data: "fine" }, ctx, { endsRun: true }),
    ).resolves.toBeUndefined();
  });

  it("throws the exception form when the node's data is an abort", async () => {
    const { ctx } = stubCtx();
    await expect(
      throwIfNodeResultAborted(abortedNodeResult(), ctx, { endsRun: true }),
    ).rejects.toThrow(/Guard exceeded its cost budget/);
  });

  it("closes the trace writer when the call site owns the end of the run", async () => {
    // Throwing skips the caller's normal end-of-run tail, which is what
    // writes the trace footer. Without this the trace stops mid-stream.
    const s = stubCtx();
    await expect(
      throwIfNodeResultAborted(abortedNodeResult(), s.ctx, { endsRun: true }),
    ).rejects.toThrow();
    expect(s.closes).toBe(1);
  });

  it("leaves the trace writer alone for the rewind loop, which has no end-of-run tail", async () => {
    const s = stubCtx();
    await expect(
      throwIfNodeResultAborted(abortedNodeResult(), s.ctx, { endsRun: false }),
    ).rejects.toThrow();
    expect(s.closes).toBe(0);
  });
});
