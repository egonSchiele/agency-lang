import { describe, it, expect, vi } from "vitest";
import { checkpoint, restore } from "./checkpoint.js";
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

    const id = await checkpoint(ctx);

    expect(resolved).toBe(true);
    expect(typeof id).toBe("number");
  });

  it("should return an id (number)", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(ctx);
    expect(id).toBe(0);
  });

  it("should return incrementing ids", async () => {
    const ctx = makeMockCtx();
    const id1 = await checkpoint(ctx);
    const id2 = await checkpoint(ctx);
    expect(id1).toBe(0);
    expect(id2).toBe(1);
  });

  it("should create a checkpoint that can be retrieved from the store", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(ctx);
    const cp = ctx.checkpoints.get(id);
    expect(cp).toBeDefined();
    expect(cp!.id).toBe(id);
    expect(cp!.nodeId).toBe("process");
  });
});

describe("restore()", () => {
  it("should throw RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(ctx);

    expect(() => restore(ctx, id)).toThrow(RestoreSignal);
  });

  it("should pass checkpoint data in RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(ctx);

    try {
      restore(ctx, id);
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.checkpoint.id).toBe(id);
      expect(signal.checkpoint.nodeId).toBe("process");
    }
  });

  it("should pass options in RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(ctx);

    const options = { messages: [{ role: "user" as const, content: "test" }] };
    try {
      restore(ctx, id, options);
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.options).toEqual(options);
    }
  });

  it("should throw CheckpointError for missing checkpoint", () => {
    const ctx = makeMockCtx();

    expect(() => restore(ctx, 999)).toThrow(CheckpointError);
    expect(() => restore(ctx, 999)).toThrow(/does not exist/);
  });

  it("should clear pending promises", async () => {
    const ctx = makeMockCtx();
    const id = await checkpoint(ctx);

    // Add a pending promise after checkpoint
    ctx.pendingPromises.add(new Promise(() => {})); // never resolves

    try {
      restore(ctx, id);
    } catch {
      // expected
    }

    // After restore, pending promises should be cleared
    // We verify by calling awaitAll which should resolve immediately if cleared
    await ctx.pendingPromises.awaitAll();
  });

  it("should invalidate later checkpoints", async () => {
    const ctx = makeMockCtx();
    const id0 = await checkpoint(ctx);
    const id1 = await checkpoint(ctx);
    const id2 = await checkpoint(ctx);

    try {
      restore(ctx, id0);
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
    const id = ctx.checkpoints.create(ctx);

    try {
      restore(ctx, id);
    } catch {
      // expected RestoreSignal
    }
    try {
      restore(ctx, id);
    } catch {
      // expected RestoreSignal
    }

    // Third restore should throw CheckpointError due to max restores exceeded
    expect(() => restore(ctx, id)).toThrow(CheckpointError);
    expect(() => restore(ctx, id)).toThrow(/Possible infinite loop/);
  });
});
