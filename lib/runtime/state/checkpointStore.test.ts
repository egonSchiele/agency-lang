import { describe, it, expect } from "vitest";
import { Checkpoint, CheckpointStore } from "./checkpointStore.js";
import {
  StateStack,
  type StateStackJSON,
  type StateJSON,
} from "./stateStack.js";
import { GlobalStore, type GlobalStoreJSON } from "./globalStore.js";
import { CheckpointError } from "../errors.js";

function makeStackJSON(frames: Partial<StateJSON>[] = []): StateStackJSON {
  return {
    stack: frames.map((f) => ({
      args: f.args ?? {},
      locals: f.locals ?? {},
      threads: f.threads ?? null,
      step: f.step ?? 0,
      ...(f.branches ? { branches: f.branches } : {}),
    })),
    mode: "serialize",
    other: {},
    deserializeStackLength: 0,
    nodesTraversed: [],
  };
}

function makeGlobalsJSON(
  store: Record<string, Record<string, any>> = {},
): GlobalStoreJSON {
  return { store, initializedModules: Object.keys(store) };
}

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

describe("Checkpoint", () => {
  describe("constructor defaults", () => {
    it("should default moduleId, scopeName, stepPath to empty string", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "start",
      });
      expect(cp!.moduleId).toBe("");
      expect(cp!.scopeName).toBe("");
      expect(cp!.stepPath).toBe("");
    });

    it("should default label to null and pinned to false", () => {
      const cp = new Checkpoint({
        id: 1,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "start",
      });
      expect(cp!.label).toBeNull();
      expect(cp!.pinned).toBe(false);
    });

    it("should use provided values", () => {
      const cp = new Checkpoint({
        id: 5,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "mod.agency",
        scopeName: "myFunc",
        stepPath: "1.2",
        label: "before-llm",
        pinned: true,
      });
      expect(cp!.id).toBe(5);
      expect(cp!.nodeId).toBe("n1");
      expect(cp!.moduleId).toBe("mod.agency");
      expect(cp!.scopeName).toBe("myFunc");
      expect(cp!.stepPath).toBe("1.2");
      expect(cp!.label).toBe("before-llm");
      expect(cp!.pinned).toBe(true);
    });
  });

  describe("getScopeKey", () => {
    it("should return moduleId:scopeName", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "foo.agency",
        scopeName: "bar",
      });
      expect(cp!.getScopeKey()).toBe("foo.agency:bar");
    });

    it("should return : when both are empty", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp!.getScopeKey()).toBe(":");
    });
  });

  describe("getCurrentFrame", () => {
    it("should return the last frame in the stack", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          { args: { a: 1 }, step: 0 },
          { args: { b: 2 }, step: 1 },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const frame = cp!.getCurrentFrame()!;
      expect(frame.args).toEqual({ b: 2 });
      expect(frame.step).toBe(1);
    });

    it("should return undefined for empty stack", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp!.getCurrentFrame()).toBeUndefined();
    });

    it("should return undefined when stack is undefined", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: { nodesTraversed: [] } as any,
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp!.getCurrentFrame()).toBeUndefined();
    });
  });

  describe("getGlobalsForModule", () => {
    it("should return globals for the checkpoint moduleId", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON({ "mod.agency": { count: 10 } }),
        nodeId: "n1",
        moduleId: "mod.agency",
      });
      expect(cp!.getGlobalsForModule()).toEqual({ count: 10 });
    });

    it("should return null when module not found in globals", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON({ "other.agency": { x: 1 } }),
        nodeId: "n1",
        moduleId: "mod.agency",
      });
      expect(cp!.getGlobalsForModule()).toBeNull();
    });

    it("should return null when globals is empty", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "mod.agency",
      });
      expect(cp!.getGlobalsForModule()).toBeNull();
    });
  });

  describe("fromJSON", () => {
    it("should return the same instance if already a Checkpoint", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(Checkpoint.fromJSON(cp)).toBe(cp);
    });

    it("should create a Checkpoint from a plain object", () => {
      const plain = {
        id: 3,
        stack: makeStackJSON([{ args: {} }]),
        globals: makeGlobalsJSON({ m: { x: 1 } }),
        nodeId: "n2",
        moduleId: "m",
        scopeName: "fn",
        stepPath: "0.1",
        label: "test",
        pinned: true,
      };
      const cp = Checkpoint.fromJSON(plain);
      expect(cp).toBeInstanceOf(Checkpoint);
      expect(cp!.id).toBe(3);
      expect(cp!.nodeId).toBe("n2");
      expect(cp!.moduleId).toBe("m");
      expect(cp!.scopeName).toBe("fn");
      expect(cp!.stepPath).toBe("0.1");
      expect(cp!.label).toBe("test");
      expect(cp!.pinned).toBe(true);
    });

    it("should handle missing optional fields", () => {
      const plain = {
        id: 1,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      };
      const cp = Checkpoint.fromJSON(plain);
      expect(cp!.moduleId).toBe("");
      expect(cp!.scopeName).toBe("");
      expect(cp!.stepPath).toBe("");
      expect(cp!.label).toBeNull();
      expect(cp!.pinned).toBe(false);
    });
  });
});

describe("CheckpointStore", () => {
  describe("create", () => {
    it("should create a checkpoint and return an id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(typeof id).toBe("number");
    });

    it("should increment ids for successive checkpoints", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id1 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id2 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(id2).toBe(id1 + 1);
    });

    it("should deep-clone the state (mutations don't affect checkpoint)", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

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
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const checkpoint = store.get(id);
      expect(checkpoint!.nodeId).toBe("process");
    });

    it("should store moduleId, scopeName, stepPath, label, and pinned from opts", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "myModule.agency",
        scopeName: "myNode",
        stepPath: "1.2.3",
        label: "before-llm-call",
        pinned: true,
      });
      const checkpoint = store.get(id);
      expect(checkpoint!.moduleId).toBe("myModule.agency");
      expect(checkpoint!.scopeName).toBe("myNode");
      expect(checkpoint!.stepPath).toBe("1.2.3");
      expect(checkpoint!.label).toBe("before-llm-call");
      expect(checkpoint!.pinned).toBe(true);
    });

    it("should default label to null and pinned to false when not provided", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "mod.agency",
        scopeName: "fn",
        stepPath: "0",
      });
      const checkpoint = store.get(id);
      expect(checkpoint!.label).toBeNull();
      expect(checkpoint!.pinned).toBe(false);
    });

    it("should store moduleId, scopeName, stepPath, label, and pinned when provided via ctx.checkpoints", () => {
      const store = new CheckpointStore();
      const ctx = { ...makeMockCtx(), checkpoints: store };
      const id = ctx.checkpoints.create(ctx, {
        moduleId: "foo.agency",
        scopeName: "main",
        stepPath: "3",
        label: "my label",
        pinned: true,
      });
      const cp = ctx.checkpoints.get(id);
      expect(cp!.moduleId).toBe("foo.agency");
      expect(cp!.scopeName).toBe("main");
      expect(cp!.stepPath).toBe("3");
      expect(cp!.label).toBe("my label");
      expect(cp!.pinned).toBe(true);
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
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const checkpoint = store.get(id);
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.id).toBe(id);
    });
  });

  describe("delete", () => {
    it("should remove a checkpoint", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
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
      const id0 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id1 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id2 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id3 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      store.deleteAfterCheckpoint(id1);

      expect(store.get(id0)).toBeDefined();
      expect(store.get(id1)).toBeDefined();
      expect(store.get(id2)).toBeUndefined();
      expect(store.get(id3)).toBeUndefined();
    });

    it("should not remove any if all ids are <= the given id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id1 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      store.deleteAfterCheckpoint(id1);

      expect(store.get(id0)).toBeDefined();
      expect(store.get(id1)).toBeDefined();
    });
  });

  describe("trackRestore", () => {
    it("should track restore count without error for counts within limit", () => {
      const store = new CheckpointStore(5);
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      expect(() => store.trackRestore(id)).not.toThrow();
      expect(() => store.trackRestore(id)).not.toThrow();
      expect(() => store.trackRestore(id)).not.toThrow();
    });

    it("should throw CheckpointError when max restores exceeded", () => {
      const store = new CheckpointStore(3);
      const ctx = makeMockCtx();
      const id = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

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
      const id0 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id1 = store.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

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
      const id1 = store.create(ctx, { moduleId: "", scopeName: "", stepPath: "" });
      const id2 = store.create(ctx, { moduleId: "", scopeName: "", stepPath: "" });

      const json = store.toJSON();
      const restored = CheckpointStore.fromJSON(json);

      // Next id should continue from where we left off
      const id = restored.create(ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(id).toBe(id2 + 1);
    });

    it("toJSON should deep-clone so mutations don't affect serialized data", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      store.create(ctx, { moduleId: "", scopeName: "", stepPath: "" });

      const json = store.toJSON();

      // Mutate the original store
      store.create(ctx, { moduleId: "", scopeName: "", stepPath: "" });

      // The JSON should only have 1 checkpoint
      expect(Object.keys(json.checkpoints)).toHaveLength(1);
    });
  });
});
