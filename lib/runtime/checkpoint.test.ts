import { describe, it, expect, vi } from "vitest";
import { checkpoint, getCheckpoint, restore } from "./checkpoint.js";
import { CheckpointStore } from "./state/checkpointStore.js";
import { StateStack } from "./state/stateStack.js";
import { GlobalStore } from "./state/globalStore.js";
import { PendingPromiseStore } from "./state/pendingPromiseStore.js";
import { CheckpointError, RestoreSignal } from "./errors.js";

function makeMockCtx() {
  const stateStack = new StateStack();
  stateStack.nodesTraversed = ["start", "process"];
  const state = stateStack.getNewState();
  state.args = { input: "hello" };
  state.locals = { x: 42 };
  state.step = 3;

  const globals = GlobalStore.withTokenStats();
  globals.set("mod1", "count", 10);

  const checkpoints = new CheckpointStore();
  const pendingPromises = new PendingPromiseStore();

  return {
    stateStack,
    globals,
    checkpoints,
    pendingPromises,
  } as any;
}

function makeState(ctx: any) {
  return { ctx } as any;
}

describe("checkpoint()", () => {
  it("should await pending promises before creating checkpoint", async () => {
    const ctx = makeMockCtx();
    let resolved = false;
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 10);
    });
    ctx.pendingPromises.add(promise);

    const id = await checkpoint(makeState(ctx));

    expect(resolved).toBe(true);
    expect(typeof id).toBe("number");
  });

  it("should return an id (number)", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));
    expect(id).toBe(0);
  });

  it("should return incrementing ids", async () => {
    const ctx = makeMockCtx();
    const state = makeState(ctx);
    const id1 = await checkpoint(state);
    const id2 = await checkpoint(state);
    expect(id1).toBe(0);
    expect(id2).toBe(1);
  });

  it("should create a checkpoint that can be retrieved from the store", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));
    const cp = ctx.checkpoints.get(id);
    expect(cp).toBeDefined();
    expect(cp!.id).toBe(id);
    expect(cp!.nodeId).toBe("process");
  });

  it("should set moduleId, scopeName, stepPath, label, and pinned to default values", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));
    const cp = ctx.checkpoints.get(id);
    expect(cp).toBeDefined();
    expect(cp!.moduleId).toBe("");
    expect(cp!.scopeName).toBe("");
    expect(cp!.stepPath).toBe("");
    expect(cp!.label).toBeNull();
    expect(cp!.pinned).toBe(false);
  });
});

describe("getCheckpoint()", () => {
  it("should return the checkpoint object", async () => {
    const ctx = makeMockCtx();
    const state = makeState(ctx);
    const id = await checkpoint(state);
    const cp = getCheckpoint(id, state);
    expect(cp).toBeDefined();
    expect(cp.id).toBe(id);
    expect(cp.nodeId).toBe("process");
    expect(cp.stack).toBeDefined();
    expect(cp.globals).toBeDefined();
  });

  it("should throw CheckpointError for missing checkpoint", () => {
    const ctx = makeMockCtx();
    const state = makeState(ctx);
    expect(() => getCheckpoint(999, state)).toThrow(CheckpointError);
    expect(() => getCheckpoint(999, state)).toThrow(/does not exist/);
  });
});

describe("restore()", () => {
  it("should throw RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));

    expect(() => restore(id, {}, makeState(ctx))).toThrow(RestoreSignal);
  });

  it("should pass checkpoint data in RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));

    try {
      restore(id, {}, makeState(ctx));
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.checkpoint.id).toBe(id);
      expect(signal.checkpoint.nodeId).toBe("process");
    }
  });

  it("should pass options in RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));

    const options = { messages: [{ role: "user" as const, content: "test" }] };
    try {
      restore(id, options, makeState(ctx));
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.options).toEqual(options);
    }
  });

  it("should accept a checkpoint object instead of an id", async () => {
    const ctx = makeMockCtx();
    const state = makeState(ctx);
    const id = await checkpoint(state);
    const cp = getCheckpoint(id, state);

    try {
      restore(cp, {}, state);
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.checkpoint.id).toBe(id);
      expect(signal.checkpoint.nodeId).toBe("process");
    }
  });

  it("should throw CheckpointError for missing checkpoint", () => {
    const ctx = makeMockCtx();

    expect(() => restore(999, {}, makeState(ctx))).toThrow(CheckpointError);
    expect(() => restore(999, {}, makeState(ctx))).toThrow(/does not exist/);
  });

  it("should clear pending promises", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(makeState(ctx));

    // Add a pending promise after checkpoint
    ctx.pendingPromises.add(new Promise(() => {})); // never resolves

    try {
      restore(id, {}, makeState(ctx));
    } catch {
      // expected
    }

    // After restore, pending promises should be cleared
    // We verify by calling awaitAll which should resolve immediately if cleared
    await ctx.pendingPromises.awaitAll();
  });

  it("should invalidate later checkpoints", async () => {
    const ctx = makeMockCtx();
    const state = makeState(ctx);
    const id0 = await checkpoint(state);
    const id1 = await checkpoint(state);
    const id2 = await checkpoint(state);

    try {
      restore(id0, {}, state);
    } catch {
      // expected
    }

    // Checkpoints after id0 should be invalidated
    expect(ctx.checkpoints.get(id0)).toBeDefined();
    expect(ctx.checkpoints.get(id1)).toBeUndefined();
    expect(ctx.checkpoints.get(id2)).toBeUndefined();
  });

  it("should track restores (infinite loop protection)", async () => {
    const ctx = makeMockCtx();
    ctx.checkpoints = new CheckpointStore(2); // max 2 restores
    const id = ctx.checkpoints.create(ctx, { moduleId: "", scopeName: "", stepPath: "" });
    const state = makeState(ctx);

    try {
      restore(id, {}, state);
    } catch {
      // expected RestoreSignal
    }
    try {
      restore(id, {}, state);
    } catch {
      // expected RestoreSignal
    }

    // Third restore should throw CheckpointError due to max restores exceeded
    expect(() => restore(id, {}, state)).toThrow(CheckpointError);
    expect(() => restore(id, {}, state)).toThrow(/Possible infinite loop/);
  });
});
