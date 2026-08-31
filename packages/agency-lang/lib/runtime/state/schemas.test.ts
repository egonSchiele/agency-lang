import { describe, it, expect } from "vitest";
import {
  stateStackJSONSchema,
  stateJSONSchema,
  branchStateJSONSchema,
  guardJSONSchema,
} from "./schemas.js";
import { Checkpoint } from "./checkpointStore.js";
import { StateStack, State } from "./stateStack.js";
import { CostGuard } from "../guard.js";

// Only `Checkpoint.fromJSON` (the external-resume path) runs a checkpoint
// through zod, and zod strips any key a schema does not name. A plain
// `StateStack.fromJSON(toJSON())` skips zod entirely, so every test here goes
// through the schema on purpose — that is the only path where a stripped field
// shows up.

describe("guardJSONSchema", () => {
  it("keeps every field of a cost guard", () => {
    const json = {
      kind: "cost",
      costLimit: 5,
      spent: 3,
      guardId: "g1",
      label: "budget",
      scopeIds: ["s1"],
      disarmed: true,
      isRootBudget: true,
    };
    expect(guardJSONSchema.parse(json)).toEqual(json);
  });

  it("keeps every field of a time guard", () => {
    const json = {
      kind: "time",
      timeLimit: 1000,
      elapsedMs: 250,
      grantedMs: 100,
      guardId: "g2",
      label: "clock",
    };
    expect(guardJSONSchema.parse(json)).toEqual(json);
  });
});

describe("stateStackJSONSchema", () => {
  it("keeps cost accounting and guard fields", () => {
    const json = {
      stack: [],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
      localCost: 1.5,
      localTokens: 42,
      seedCost: 0.5,
      seedTokens: 10,
      guards: [{ kind: "cost", costLimit: 5, spent: 3, guardId: "g1" }],
      inheritedGuardCount: 2,
      inheritedTimeGuards: [{ kind: "time", timeLimit: 1000, elapsedMs: 250, guardId: "g2" }],
    };
    expect(stateStackJSONSchema.parse(json)).toEqual(json);
  });
});

describe("stateJSONSchema", () => {
  it("keeps scopedCallbacks and savedDraft", () => {
    const json = {
      args: {},
      locals: {},
      threads: null,
      step: 0,
      scopeName: "main",
      scopedCallbacks: [{ name: "cb", fn: null }],
      savedDraft: { value: { best: "so far" } },
    };
    expect(stateJSONSchema.parse(json)).toEqual(json);
  });
});

describe("branchStateJSONSchema", () => {
  it("keeps result, globalsJSON, and activeStack", () => {
    const json = {
      stack: {
        stack: [],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: [],
      },
      interruptId: "int-1",
      result: { result: 99 },
      globalsJSON: { store: { "mod.agency": { x: 1 } }, initializedModules: ["mod.agency"] },
      activeStack: ["thread-1"],
    };
    expect(branchStateJSONSchema.parse(json)).toEqual(json);
  });
});

describe("Checkpoint.fromJSON round trip", () => {
  it("preserves guards, cost, savedDraft, and per-branch state through the schema", () => {
    const original = {
      id: 7,
      nodeId: "start",
      moduleId: "mod.agency",
      scopeName: "main",
      stepPath: "0",
      label: null,
      pinned: false,
      globals: { store: {}, initializedModules: [] },
      stack: {
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: [],
        localCost: 2.25,
        localTokens: 100,
        seedCost: 1.0,
        seedTokens: 50,
        guards: [{ kind: "cost", costLimit: 10, spent: 4, guardId: "g1", label: "budget" }],
        inheritedGuardCount: 0,
        inheritedTimeGuards: [{ kind: "time", timeLimit: 5000, elapsedMs: 1200, guardId: "g2" }],
        stack: [
          {
            args: {},
            locals: {},
            threads: null,
            step: 1,
            scopeName: "main",
            savedDraft: { value: "draft" },
            branches: {
              fork_1_0: {
                stack: {
                  stack: [],
                  mode: "serialize",
                  other: {},
                  deserializeStackLength: 0,
                  nodesTraversed: [],
                },
                interruptId: "int-1",
                result: { result: "done" },
                activeStack: ["t1"],
              },
            },
          },
        ],
      },
    };

    // Serialize the way an external store would, then revive.
    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(original)));
    expect(revived).not.toBeNull();

    const stack = revived!.stack;
    expect(stack.localCost).toBe(2.25);
    expect(stack.localTokens).toBe(100);
    expect(stack.seedCost).toBe(1.0);
    expect(stack.seedTokens).toBe(50);
    expect(stack.guards).toEqual(original.stack.guards);
    expect(stack.inheritedTimeGuards).toEqual(original.stack.inheritedTimeGuards);

    const frame = stack.stack[0];
    expect(frame.savedDraft).toEqual({ value: "draft" });
    const branch = frame.branches!["fork_1_0"];
    expect(branch.result).toEqual({ result: "done" });
    expect(branch.activeStack).toEqual(["t1"]);
  });

  it("survives a full toJSON -> Checkpoint.fromJSON -> StateStack.fromJSON with real guards", () => {
    const stateStack = new StateStack([new State({ step: 1 })], "serialize");
    const costGuard = new CostGuard(10, "budget");
    costGuard.charge(4);
    stateStack.pushGuard(costGuard);
    stateStack.localCost = 4;
    stateStack.stack[0].savedDraft = { value: "best-so-far" };

    const cp = new Checkpoint({
      id: 0,
      stack: stateStack.toJSON(),
      globals: { store: {}, initializedModules: [] },
      nodeId: "start",
    });

    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(cp.toJSON())));
    expect(revived).not.toBeNull();

    const restored = StateStack.fromJSON(revived!.stack);
    expect(restored.localCost).toBe(4);
    const costGuards = restored.guards.filter((g) => g instanceof CostGuard) as CostGuard[];
    expect(costGuards).toHaveLength(1);
    // spent is private; read it back through the guard's own JSON shape.
    expect(costGuards[0].toJSON()).toMatchObject({ kind: "cost", spent: 4, costLimit: 10 });
    expect(restored.stack[0].savedDraft).toEqual({ value: "best-so-far" });
  });

  it("keeps the signature field through Checkpoint.fromJSON", () => {
    const original = {
      id: 1,
      nodeId: "start",
      moduleId: "mod.agency",
      scopeName: "main",
      stepPath: "0",
      label: null,
      pinned: false,
      signature: "deadbeef",
      globals: { store: {}, initializedModules: [] },
      stack: {
        stack: [],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: [],
      },
    };
    const revived = Checkpoint.fromJSON(JSON.parse(JSON.stringify(original)));
    expect(revived).not.toBeNull();
    expect(revived!.signature).toBe("deadbeef");
  });
});
