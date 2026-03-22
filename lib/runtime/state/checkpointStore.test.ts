import { describe, it, expect } from "vitest";
import { CheckpointStore } from "./checkpointStore.js";
import { StateStack } from "./stateStack.js";
import { GlobalStore } from "./globalStore.js";
import { CheckpointError } from "../errors.js";

function makeMockCtx() {
  const stateStack = new StateStack();
  stateStack.nodesTraversed = ["start", "process"];
  // Push a frame so there's something in the stack
  const state = stateStack.getNewState();
  state.args = { input: "hello" };
  state.locals = { x: 42 };
  state.step = 3;

  const globals = GlobalStore.withTokenStats();
  globals.set("mod1", "count", 10);

  return {
    stateStack,
    globals,
  } as any; // cast to RuntimeContext shape
}

describe("CheckpointStore", () => {
  describe("create", () => {
    it("should create a checkpoint and return an id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx);
      expect(id).toBe(0);
    });

    it("should increment ids for successive checkpoints", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id1 = store.create(ctx);
      const id2 = store.create(ctx);
      expect(id1).toBe(0);
      expect(id2).toBe(1);
    });

    it("should deep-clone the state (mutations don't affect checkpoint)", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx);

      // Mutate original context
      ctx.stateStack.nodesTraversed.push("mutated");
      ctx.globals.set("mod1", "count", 999);

      const checkpoint = store.get(id);
      expect(checkpoint).toBeDefined();
      // The checkpoint should not reflect the mutation
      expect(checkpoint!.stack.nodesTraversed).toEqual(["start", "process"]);
      expect(checkpoint!.globals.store["mod1"]["count"]).toBe(10);
    });

    it("should capture the current nodeId", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx);
      const checkpoint = store.get(id);
      expect(checkpoint!.nodeId).toBe("process");
    });
  });

  describe("get", () => {
    it("should return undefined for non-existent id", () => {
      const store = new CheckpointStore();
      expect(store.get(999)).toBeUndefined();
    });

    it("should return the checkpoint for a valid id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx);
      const checkpoint = store.get(id);
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.id).toBe(id);
    });
  });

  describe("delete", () => {
    it("should remove a checkpoint", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx);
      expect(store.get(id)).toBeDefined();
      store.delete(id);
      expect(store.get(id)).toBeUndefined();
    });

    it("should not throw for non-existent id", () => {
      const store = new CheckpointStore();
      expect(() => store.delete(999)).not.toThrow();
    });
  });

  describe("invalidateAfter", () => {
    it("should remove all checkpoints with id > the given id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx);
      const id1 = store.create(ctx);
      const id2 = store.create(ctx);
      const id3 = store.create(ctx);

      store.invalidateAfter(id1);

      expect(store.get(id0)).toBeDefined();
      expect(store.get(id1)).toBeDefined();
      expect(store.get(id2)).toBeUndefined();
      expect(store.get(id3)).toBeUndefined();
    });

    it("should not remove any if all ids are <= the given id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx);
      const id1 = store.create(ctx);

      store.invalidateAfter(id1);

      expect(store.get(id0)).toBeDefined();
      expect(store.get(id1)).toBeDefined();
    });
  });

  describe("trackRestore", () => {
    it("should track restore count without error for counts within limit", () => {
      const store = new CheckpointStore(5);
      const ctx = makeMockCtx();
      const id = store.create(ctx);

      expect(() => store.trackRestore(id)).not.toThrow();
      expect(() => store.trackRestore(id)).not.toThrow();
      expect(() => store.trackRestore(id)).not.toThrow();
    });

    it("should throw CheckpointError when max restores exceeded", () => {
      const store = new CheckpointStore(3);
      const ctx = makeMockCtx();
      const id = store.create(ctx);

      store.trackRestore(id);
      store.trackRestore(id);
      store.trackRestore(id);

      expect(() => store.trackRestore(id)).toThrow(CheckpointError);
      expect(() => store.trackRestore(id)).toThrow(/Possible infinite loop/);
    });
  });

  describe("toJSON / fromJSON", () => {
    it("should serialize and deserialize correctly", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx);
      const id1 = store.create(ctx);

      const json = store.toJSON();
      const restored = CheckpointStore.fromJSON(json);

      expect(restored.get(id0)).toBeDefined();
      expect(restored.get(id0)!.id).toBe(id0);
      expect(restored.get(id1)).toBeDefined();
      expect(restored.get(id1)!.id).toBe(id1);
    });

    it("should preserve counter across serialization", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      store.create(ctx); // id 0
      store.create(ctx); // id 1

      const json = store.toJSON();
      const restored = CheckpointStore.fromJSON(json);

      // Next id should continue from where we left off
      const id = restored.create(ctx);
      expect(id).toBe(2);
    });

    it("toJSON should deep-clone so mutations don't affect serialized data", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      store.create(ctx);

      const json = store.toJSON();

      // Mutate the original store
      store.create(ctx);

      // The JSON should only have 1 checkpoint
      expect(Object.keys(json.checkpoints)).toHaveLength(1);
    });
  });
});
