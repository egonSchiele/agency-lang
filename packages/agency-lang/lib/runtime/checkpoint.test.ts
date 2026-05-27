import { describe, it, expect } from "vitest";
import { checkpoint, getCheckpoint, restore } from "./checkpoint.js";
import { CheckpointError, RestoreSignal } from "./errors.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";
import { CheckpointStore } from "./index.js";
import { runInTestContext, withCallsite } from "./asyncContext.js";
import { ThreadStore } from "./state/threadStore.js";

// Post-ALS migration: the checkpoint stdlib helpers read `ctx` and
// `stateStack` from `getRuntimeContext()`. Each test wraps its
// invocations in an `agencyStore` frame via `runInTestContext`.
function wrap<T>(ctx: any, fn: () => T): T {
  return runInTestContext(ctx, ctx.stateStack, new ThreadStore(), fn);
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

    const id = await wrap(ctx, () => checkpoint());

    expect(resolved).toBe(true);
    expect(typeof id).toBe("number");
  });

  it("should return an id (number)", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());
    expect(typeof id).toBe("number");
  });

  it("should return incrementing ids", async () => {
    const ctx = makeMockCtx();
    const id1 = await wrap(ctx, () => checkpoint());
    const id2 = await wrap(ctx, () => checkpoint());
    expect(id2).toBe(id1 + 1);
  });

  it("should create a checkpoint that can be retrieved from the store", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());
    const cp = ctx.checkpoints.get(id);
    expect(cp).toBeDefined();
    expect(cp!.id).toBe(id);
    expect(cp!.nodeId).toBe("process");
  });

  it("should set moduleId, scopeName, stepPath, label, and pinned to default values", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());
    const cp = ctx.checkpoints.get(id);
    expect(cp).toBeDefined();
    expect(cp!.moduleId).toBe("");
    expect(cp!.scopeName).toBe("");
    expect(cp!.stepPath).toBe("");
    expect(cp!.label).toBeNull();
    expect(cp!.pinned).toBe(false);
  });

  it("records location from the active callsite slot", async () => {
    const ctx = makeMockCtx();
    const id = await runInTestContext(
      ctx,
      ctx.stateStack,
      new ThreadStore(),
      () =>
        withCallsite(
          { moduleId: "modA", scopeName: "scopeB", stepPath: "1.2" },
          () => checkpoint(),
        ),
    );
    const cp = ctx.checkpoints.get(id)!;
    expect(cp.moduleId).toBe("modA");
    expect(cp.scopeName).toBe("scopeB");
    expect(cp.stepPath).toBe("1.2");
  });

  it("falls back to empty location when no callsite set", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());
    const cp = ctx.checkpoints.get(id)!;
    expect(cp.moduleId).toBe("");
    expect(cp.scopeName).toBe("");
    expect(cp.stepPath).toBe("");
  });
});

describe("getCheckpoint()", () => {
  it("should return the checkpoint object", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());
    const cp = wrap(ctx, () => getCheckpoint(id));
    expect(cp).toBeDefined();
    expect(cp.id).toBe(id);
    expect(cp.nodeId).toBe("process");
    expect(cp.stack).toBeDefined();
    expect(cp.globals).toBeDefined();
  });

  it("should throw CheckpointError for missing checkpoint", () => {
    const ctx = makeMockCtx();
    expect(() => wrap(ctx, () => getCheckpoint(999))).toThrow(CheckpointError);
    expect(() => wrap(ctx, () => getCheckpoint(999))).toThrow(/does not exist/);
  });
});

describe("restore()", () => {
  it("should throw RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());

    expect(() => wrap(ctx, () => restore(id, {}))).toThrow(RestoreSignal);
  });

  it("should pass checkpoint data in RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());

    try {
      wrap(ctx, () => restore(id, {}));
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.checkpoint.id).toBe(id);
      expect(signal.checkpoint.nodeId).toBe("process");
    }
  });

  it("should pass options in RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());

    const options = { messages: [{ role: "user" as const, content: "test" }] };
    try {
      wrap(ctx, () => restore(id, options));
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.options).toEqual(options);
    }
  });

  it("should accept a checkpoint object instead of an id", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());
    const cp = wrap(ctx, () => getCheckpoint(id));

    try {
      wrap(ctx, () => restore(cp, {}));
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreSignal);
      const signal = e as RestoreSignal;
      expect(signal.checkpoint.id).toBe(id);
      expect(signal.checkpoint.nodeId).toBe("process");
    }
  });

  it("should throw CheckpointError for missing checkpoint", () => {
    const ctx = makeMockCtx();

    expect(() => wrap(ctx, () => restore(999, {}))).toThrow(CheckpointError);
    expect(() => wrap(ctx, () => restore(999, {}))).toThrow(/does not exist/);
  });

  it("should clear pending promises", async () => {
    const ctx = makeMockCtx();
    const id = await wrap(ctx, () => checkpoint());

    // Add a pending promise after checkpoint
    ctx.pendingPromises.add(new Promise(() => { })); // never resolves

    try {
      wrap(ctx, () => restore(id, {}));
    } catch {
      // expected
    }

    // After restore, pending promises should be cleared
    // We verify by calling awaitAll which should resolve immediately if cleared
    await ctx.pendingPromises.awaitAll();
  });

  it("should invalidate later checkpoints", async () => {
    const ctx = makeMockCtx();
    const id0 = await wrap(ctx, () => checkpoint());
    const id1 = await wrap(ctx, () => checkpoint());
    const id2 = await wrap(ctx, () => checkpoint());

    try {
      wrap(ctx, () => restore(id0, {}));
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
    const id = ctx.checkpoints.create(ctx.stateStack, ctx, { moduleId: "", scopeName: "", stepPath: "" });

    try {
      wrap(ctx, () => restore(id, {}));
    } catch {
      // expected RestoreSignal
    }
    try {
      wrap(ctx, () => restore(id, {}));
    } catch {
      // expected RestoreSignal
    }

    // Third restore should throw CheckpointError due to max restores exceeded
    expect(() => wrap(ctx, () => restore(id, {}))).toThrow(CheckpointError);
    expect(() => wrap(ctx, () => restore(id, {}))).toThrow(/Possible infinite loop/);
  });
});
