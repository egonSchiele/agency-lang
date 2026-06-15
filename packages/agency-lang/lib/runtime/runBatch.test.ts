import { describe, expect, it } from "vitest";
import type { Interrupt } from "./interrupts.js";
import { runBatch } from "./runBatch.js";
import { State, StateStack } from "./state/stateStack.js";

/** Build a synthetic Checkpoint-ish object (only the fields runBatch reads
 *  matter for these tests). */
function fakeLeafCheckpoint(id: number): any {
  return {
    id,
    moduleId: "m",
    scopeName: "s",
    stepPath: `leaf.${id}`,
    stack: { frames: [] },
  };
}

function fakeInterrupt(idSuffix = "1", checkpointId = 100): Interrupt {
  return {
    type: "interrupt",
    effect: "test",
    message: "test",
    origin: "test",
    runId: "r-1",
    interruptId: `i-${idSuffix}`,
    data: { foo: idSuffix },
    interruptData: { foo: idSuffix } as any,
    checkpointId,
    checkpoint: fakeLeafCheckpoint(checkpointId),
  };
}

type StubCtx = {
  ctx: any;
  /** List of `create` invocations (so tests can assert "stamped once"). */
  createCalls: Array<{ stack: any; opts: any }>;
};

function makeCtx(): StubCtx {
  const createCalls: Array<{ stack: any; opts: any }> = [];
  let nextCpId = 1000;
  const stored: Record<number, any> = {};
  const ctx: any = {
    checkpoints: {
      create: (stack: any, _ctx: any, opts: any) => {
        const id = nextCpId++;
        createCalls.push({ stack, opts });
        stored[id] = {
          id,
          moduleId: opts.moduleId,
          scopeName: opts.scopeName,
          stepPath: opts.stepPath,
          stack: { frames: [] },
        };
        return id;
      },
      get: (id: number) => stored[id],
    },
    statelogClient: {
      snapshotStack: () => undefined,
      // Pass-through; AsyncLocalStorage isolation isn't observable here.
      runInBranchContext: (_s: any, fn: () => any) => fn(),
    },
  };
  return { ctx, createCalls };
}

function makeParent() {
  const parentStack = new StateStack();
  const parentFrame = new State();
  return { parentStack, parentFrame };
}

const cpLoc = { moduleId: "m", scopeName: "s", stepPath: "0" };

describe("runBatch — mode 'all'", () => {
  it("single child returning a value → kind=values", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const result = await runBatch<number>({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [{ key: "c0", invoke: async () => 42 }],
    });
    expect(result).toEqual({ kind: "values", values: [42] });
    // popBranches was called → no leftover branch state.
    expect(parentFrame.getBranch("c0")).toBeUndefined();
  });

  it("single child returning interrupts → kind=interrupts, leaf checkpoint kept on BranchState", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const leafIntr = fakeInterrupt("a", 77);
    const leafCp = leafIntr.checkpoint!;
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [{ key: "c0", invoke: async () => [leafIntr] }],
    });
    expect(result.kind).toBe("interrupts");
    // The interrupt's checkpoint was overwritten with the batch-level one
    // (id != 77 since the stub starts at 1000), but the leaf checkpoint
    // survives on the BranchState — the vehicle State.toJSON's branches
    // walk uses.
    expect(parentFrame.getBranch("c0")?.checkpoint).toBe(leafCp);
    expect(leafIntr.checkpointId).not.toBe(77);
    expect(leafIntr.checkpoint).not.toBe(leafCp);
  });

  it("mixed outcomes: surviving value cached, interrupting branches batched into one shared checkpoint", async () => {
    const { ctx, createCalls } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const i1 = fakeInterrupt("x", 10);
    const i2 = fakeInterrupt("y", 11);
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [
        { key: "c0", invoke: async () => [i1] },
        { key: "c1", invoke: async () => "ok" },
        { key: "c2", invoke: async () => [i2] },
      ],
    });
    expect(result.kind).toBe("interrupts");
    if (result.kind !== "interrupts") return;
    expect(result.interrupts).toHaveLength(2);
    // ONE shared checkpoint stamped.
    expect(createCalls).toHaveLength(1);
    // Both interrupts now point at it.
    expect(result.interrupts[0].checkpointId).toBe(result.interrupts[1].checkpointId);
    // The non-interrupting branch still cached its result.
    expect(parentFrame.getBranch("c1")?.result).toEqual({ result: "ok" });
  });

  it("cached branch short-circuits: invoke is not called and onBranchStart/onBranchEnd do not fire", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    // Pre-populate a branch as if a previous resume already completed it.
    parentFrame.getOrCreateBranch("c0");
    parentFrame.setResultOnBranch("c0", 42);

    let invokeCalls = 0;
    let starts = 0;
    let ends = 0;
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [
        {
          key: "c0",
          invoke: async () => {
            invokeCalls++;
            return 0;
          },
        },
      ],
      hooks: {
        onBranchStart: () => starts++,
        onBranchEnd: () => ends++,
      },
    });
    expect(invokeCalls).toBe(0);
    expect(starts).toBe(0);
    expect(ends).toBe(0);
    expect(result).toEqual({ kind: "values", values: [42] });
  });

  it("parent abort signal propagates into child stack", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const ctrl = new AbortController();
    parentStack.abortSignal = ctrl.signal;
    ctrl.abort();

    const seen: boolean[] = [];
    await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [
        {
          key: "c0",
          invoke: async (_s, sig) => {
            seen.push(sig.aborted);
            return 1;
          },
        },
      ],
    });
    expect(seen).toEqual([true]);
  });

  it("empty children: returns empty values, no checkpoint stamped, propagate/popBranches still safe", async () => {
    const { ctx, createCalls } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    let propagateCalls = 0;
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [],
      hooks: {
        propagateBranchCost: (b) => {
          propagateCalls++;
          expect(b).toEqual([]);
        },
      },
    });
    expect(result).toEqual({ kind: "values", values: [] });
    expect(createCalls).toHaveLength(0);
    expect(propagateCalls).toBe(1);
  });

  it("beforeCheckpoint hook fires immediately before ctx.checkpoints.create and can mutate frame locals visible in the deep-clone", async () => {
    // Regression test for the messagesJSON-ordering bug surfaced in
    // PR #186 review (Copilot inline comment). Without this hook
    // runPrompt's tool loop loses successful sibling tool responses
    // on resume because `ctx.checkpoints.create` deep-clones
    // `self.locals` synchronously at create time, so any post-create
    // mutation isn't reflected in the captured state.
    const { ctx, createCalls } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    // Seed locals with a stale value the way prompt.ts line 422 does.
    parentFrame.locals.messagesJSON = ["stale"];
    const order: string[] = [];
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [
        {
          key: "c0",
          invoke: async () => {
            // Simulate the per-tool body pushing a new entry that
            // belongs in messagesJSON but isn't reflected there yet.
            order.push("invoke");
            return [fakeInterrupt("with-before-cp")];
          },
        },
      ],
      hooks: {
        beforeCheckpoint: () => {
          order.push("beforeCheckpoint");
          // Caller is expected to flush the up-to-date snapshot here.
          parentFrame.locals.messagesJSON = ["stale", "fresh"];
        },
        onCheckpoint: () => order.push("onCheckpoint"),
      },
    });
    expect(result.kind).toBe("interrupts");
    // Hook fires after invoke completes and BEFORE checkpoint is stamped.
    expect(order).toEqual(["invoke", "beforeCheckpoint", "onCheckpoint"]);
    expect(createCalls).toHaveLength(1);
    // The mutation done inside beforeCheckpoint is observable to the
    // checkpoint's deep-clone (proxy: the live frame holds the fresh
    // value at create time; deep-clone in checkpointStore captures
    // exactly that — covered end-to-end by the agency-js test
    // `parallel-tools-resume-messages-intact`).
    expect(parentFrame.locals.messagesJSON).toEqual(["stale", "fresh"]);
  });

  it("duplicate child keys throw with a clear message and no side effects", async () => {
    const { ctx, createCalls } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    await expect(
      runBatch({
        ctx,
        parentStack,
        parentFrame,
        checkpointLocation: cpLoc,
        mode: "all",
        children: [
          { key: "dup", invoke: async () => 1 },
          { key: "dup", invoke: async () => 2 },
        ],
      }),
    ).rejects.toThrow(/duplicate child key/);
    expect(createCalls).toHaveLength(0);
    expect(parentFrame.getBranch("dup")).toBeUndefined();
  });

  it("rejection in a child rethrows and abandons sibling interrupts (documented invariant)", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const err = new Error("boom");
    await expect(
      runBatch({
        ctx,
        parentStack,
        parentFrame,
        checkpointLocation: cpLoc,
        mode: "all",
        children: [
          { key: "c0", invoke: async () => [fakeInterrupt()] },
          { key: "c1", invoke: async () => { throw err; } },
        ],
      }),
    ).rejects.toBe(err);
  });

  it("propagateBranchCost fires once on success with all branches", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    let calls = 0;
    let lastLen = 0;
    await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [
        { key: "a", invoke: async () => 1 },
        { key: "b", invoke: async () => 2 },
      ],
      hooks: {
        propagateBranchCost: (branches) => {
          calls++;
          lastLen = branches.length;
        },
      },
    });
    expect(calls).toBe(1);
    expect(lastLen).toBe(2);
  });

  it("onCheckpoint fires once with the stamped id when interrupts are produced", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const cpIds: number[] = [];
    await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "all",
      children: [{ key: "c0", invoke: async () => [fakeInterrupt()] }],
      hooks: { onCheckpoint: (id) => cpIds.push(id) },
    });
    expect(cpIds).toHaveLength(1);
  });
});

describe("runBatch — mode 'sequential'", () => {
  it("invokes children one after the previous, preserving order", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const log: string[] = [];
    const make = (k: string) => ({
      key: k,
      invoke: async () => {
        log.push(`start-${k}`);
        // Yield, then resolve. Sequential mode must wait for this to settle
        // before starting the next child.
        await new Promise((r) => setTimeout(r, 1));
        log.push(`end-${k}`);
        return k;
      },
    });
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "sequential",
      children: [make("a"), make("b"), make("c")],
    });
    expect(result).toEqual({ kind: "values", values: ["a", "b", "c"] });
    expect(log).toEqual([
      "start-a",
      "end-a",
      "start-b",
      "end-b",
      "start-c",
      "end-c",
    ]);
  });

  it("stamps a single shared checkpoint when any child interrupts", async () => {
    const { ctx, createCalls } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "sequential",
      children: [
        { key: "a", invoke: async () => 1 },
        { key: "b", invoke: async () => [fakeInterrupt("seq-b")] },
        { key: "c", invoke: async () => [fakeInterrupt("seq-c")] },
      ],
    });
    expect(createCalls).toHaveLength(1);
  });
});

describe("runBatch — mode 'race'", () => {
  const WINNER_KEY = "__race_winner_test";

  it("first to settle wins; losers are aborted and their branches deleted", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "race",
      raceWinnerLocalKey: WINNER_KEY,
      children: [
        {
          key: "fast",
          invoke: async () => "fast-value",
        },
        {
          key: "slow",
          invoke: async (_s, sig) => {
            // Wait forever unless aborted.
            return new Promise<string>((_resolve, reject) => {
              sig.addEventListener("abort", () => reject(new Error("aborted")));
            });
          },
        },
      ],
    });
    expect(result).toEqual({ kind: "values", values: ["fast-value"] });
    // Winner index persisted.
    expect(parentFrame.locals[WINNER_KEY]).toBe(0);
    // Loser branch deleted; winner branch persisted (with cached result).
    expect(parentFrame.getBranch("fast")?.result).toEqual({
      result: "fast-value",
    });
    expect(() => parentFrame.getBranch("slow")).toThrow(/has been deleted/);
  });

  it("winner halts with interrupts: loser deleted, shared checkpoint stamped, leaf cp survives on winner branch", async () => {
    const { ctx, createCalls } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    const intr = fakeInterrupt("race", 50);
    const leafCp = intr.checkpoint!;
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "race",
      raceWinnerLocalKey: WINNER_KEY,
      children: [
        { key: "fast", invoke: async () => [intr] },
        {
          key: "slow",
          invoke: async (_s, sig) =>
            new Promise<any>((_r, reject) =>
              sig.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        },
      ],
    });
    expect(result.kind).toBe("interrupts");
    expect(parentFrame.locals[WINNER_KEY]).toBe(0);
    expect(createCalls).toHaveLength(1);
    expect(parentFrame.getBranch("fast")?.checkpoint).toBe(leafCp);
    expect(() => parentFrame.getBranch("slow")).toThrow(/has been deleted/);
    // Winner's interrupt was overwritten with batch checkpoint id.
    if (result.kind === "interrupts") {
      expect(result.interrupts[0].checkpointId).not.toBe(50);
    }
  });

  it("race resume: with raceWinnerLocalKey persisted, only the winner is invoked", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    // Pre-populate a winner index. Also create the winner branch (as if
    // it had been created during the first race) but leave .result unset
    // so the resume must re-run the body.
    parentFrame.locals[WINNER_KEY] = 1;
    parentFrame.getOrCreateBranch("c1");

    let aInvoked = false;
    let bInvoked = false;
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "race",
      raceWinnerLocalKey: WINNER_KEY,
      children: [
        { key: "c0", invoke: async () => { aInvoked = true; return "a"; } },
        { key: "c1", invoke: async () => { bInvoked = true; return "b"; } },
      ],
    });
    expect(aInvoked).toBe(false);
    expect(bInvoked).toBe(true);
    expect(result).toEqual({ kind: "values", values: ["b"] });
  });

  it("race resume with cached winner result skips invoke entirely and does not double-bill cost", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    parentFrame.locals[WINNER_KEY] = 0;
    parentFrame.getOrCreateBranch("c0");
    parentFrame.setResultOnBranch("c0", "cached");

    let invokes = 0;
    let winnerCostCalls = 0;
    const result = await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "race",
      raceWinnerLocalKey: WINNER_KEY,
      children: [
        { key: "c0", invoke: async () => { invokes++; return "x"; } },
        { key: "c1", invoke: async () => { invokes++; return "y"; } },
      ],
      hooks: { propagateWinnerCost: () => { winnerCostCalls++; } },
    });
    expect(invokes).toBe(0);
    // Cost was already propagated when winner first completed; defensive
    // cached path must NOT propagate again (matches today's
    // resumeRaceWinner cached-branch behavior).
    expect(winnerCostCalls).toBe(0);
    expect(result).toEqual({ kind: "values", values: ["cached"] });
  });

  it("race success first-time: propagateLoserCost + propagateWinnerCost both fire", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    let loserCalls = 0;
    let winnerCalls = 0;
    await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "race",
      raceWinnerLocalKey: WINNER_KEY,
      children: [
        { key: "c0", invoke: async () => "winner" },
        {
          key: "c1",
          invoke: async (_s, sig) =>
            new Promise<any>((_r, reject) =>
              sig.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        },
      ],
      hooks: {
        propagateLoserCost: () => loserCalls++,
        propagateWinnerCost: () => winnerCalls++,
      },
    });
    expect(loserCalls).toBe(1);
    expect(winnerCalls).toBe(1);
  });

  it("race interrupt first-time: propagateLoserCost fires, propagateWinnerCost is deferred", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    let loserCalls = 0;
    let winnerCalls = 0;
    await runBatch({
      ctx,
      parentStack,
      parentFrame,
      checkpointLocation: cpLoc,
      mode: "race",
      raceWinnerLocalKey: WINNER_KEY,
      children: [
        { key: "c0", invoke: async () => [fakeInterrupt("rinterrupt")] },
        {
          key: "c1",
          invoke: async (_s, sig) =>
            new Promise<any>((_r, reject) =>
              sig.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        },
      ],
      hooks: {
        propagateLoserCost: () => loserCalls++,
        propagateWinnerCost: () => winnerCalls++,
      },
    });
    expect(loserCalls).toBe(1);
    expect(winnerCalls).toBe(0);
  });

  it("mode-flip defensive assert: race-winner persisted but mode='all' throws", async () => {
    const { ctx } = makeCtx();
    const { parentStack, parentFrame } = makeParent();
    parentFrame.locals[WINNER_KEY] = 0;
    await expect(
      runBatch({
        ctx,
        parentStack,
        parentFrame,
        checkpointLocation: cpLoc,
        mode: "all",
        raceWinnerLocalKey: WINNER_KEY,
        children: [{ key: "c0", invoke: async () => 1 }],
      }),
    ).rejects.toThrow(/checkpoint\/mode mismatch/);
  });
});
