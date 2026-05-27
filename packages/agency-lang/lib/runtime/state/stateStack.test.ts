import { describe, it, expect } from "vitest";
import { StateStack, State, BranchState } from "./stateStack.js";
import { _callbackImpl } from "../../stdlib/agency.js";
import { CostGuard, GuardExceededError } from "../guard.js";
import { runInTestContext } from "../asyncContext.js";
import { ThreadStore } from "./threadStore.js";

// Post-ALS migration: `_callbackImpl` reads `ctx` from
// `getRuntimeContext()`, so each call must run inside an ALS frame
// seeded with the fake ctx. Wrap _callbackImpl invocations here.
function callCallback(ctx: any, name: string, fn: unknown): void {
  runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () => {
    _callbackImpl(name, fn);
  });
}

type FrameOpts = {
  args?: Record<string, any>;
  locals?: Record<string, any>;
  threads?: any;
  step?: number;
  branches?: Record<string, BranchState>;
};

function makeFrame(overrides: FrameOpts = {}): State {
  return new State(overrides);
}

describe("StateStack branches serialization", () => {
  it("toJSON serializes branches recursively", () => {
    const childStack = new StateStack(
      [makeFrame({ args: { x: 1 }, step: 2 })],
      "serialize",
    );

    const parentFrame = makeFrame({
      args: { name: "parent" },
      step: 3,
      branches: {
        0: {
          stack: childStack,
          interruptId: "int-1",
          interruptData: { msg: "hello" },
        },
      },
    });

    const parentStack = new StateStack([parentFrame], "serialize");
    const json = parentStack.toJSON();

    expect(json.stack).toHaveLength(1);
    const serializedFrame = json.stack[0] as any;
    expect(serializedFrame.branches).toBeDefined();
    expect(serializedFrame.branches["0"]).toBeDefined();
    expect(serializedFrame.branches["0"].interruptId).toBe("int-1");
    expect(serializedFrame.branches["0"].interruptData).toEqual({
      msg: "hello",
    });
    // The child stack should be serialized as a plain StateStackJSON, not a StateStack instance
    expect(serializedFrame.branches["0"].stack.stack).toHaveLength(1);
    expect(serializedFrame.branches["0"].stack.stack[0].args).toEqual({ x: 1 });
    expect(serializedFrame.branches["0"].stack.stack[0].step).toBe(2);
  });

  it("fromJSON deserializes branches into live StateStack instances", () => {
    const json = {
      stack: [
        {
          args: { name: "parent" },
          locals: {},
          threads: null,
          step: 3,
          branches: {
            0: {
              stack: {
                stack: [{ args: { x: 1 }, locals: {}, threads: null, step: 2 }],
                mode: "serialize" as const,
                other: {},
                deserializeStackLength: 0,
                nodesTraversed: [],
              },
              interruptId: "int-1",
            },
          },
        },
      ],
      mode: "serialize" as const,
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: ["nodeA"],
    };

    const restored = StateStack.fromJSON(json as any);
    expect(restored.stack).toHaveLength(1);
    expect(restored.nodesTraversed).toEqual(["nodeA"]);

    const frame = restored.stack[0];
    const branch = frame.getBranch("0");
    expect(branch).toBeDefined();
    expect(branch!.interruptId).toBe("int-1");

    // The branch stack should be a live StateStack instance
    const childStack = branch!.stack;
    expect(childStack).toBeInstanceOf(StateStack);
    expect(childStack.stack).toHaveLength(1);
    expect(childStack.stack[0].args).toEqual({ x: 1 });
    expect(childStack.stack[0].step).toBe(2);
  });

  it("round-trips nested branches (parent → child → grandchild)", () => {
    const grandchildStack = new StateStack(
      [makeFrame({ args: { level: "grandchild" }, step: 1 })],
      "serialize",
    );

    const childFrame = makeFrame({
      args: { level: "child" },
      step: 2,
      branches: {
        0: { stack: grandchildStack },
      },
    });
    const childStack = new StateStack([childFrame], "serialize");

    const parentFrame = makeFrame({
      args: { level: "parent" },
      step: 3,
      branches: {
        0: { stack: childStack, interruptId: "top-interrupt" },
      },
    });
    const parentStack = new StateStack([parentFrame], "serialize");
    parentStack.nodesTraversed = ["A", "B"];

    // Serialize
    const json = parentStack.toJSON();

    // Deserialize
    const restored = StateStack.fromJSON(json);

    // Verify parent
    expect(restored.stack).toHaveLength(1);
    expect(restored.stack[0].args).toEqual({ level: "parent" });
    expect(restored.nodesTraversed).toEqual(["A", "B"]);

    // Verify child
    const childBranch = restored.stack[0].getBranch("0")!;
    expect(childBranch.interruptId).toBe("top-interrupt");
    expect(childBranch.stack).toBeInstanceOf(StateStack);
    expect(childBranch.stack.stack[0].args).toEqual({ level: "child" });

    // Verify grandchild
    const grandchildBranch = childBranch.stack.stack[0].getBranch("0")!;
    expect(grandchildBranch.stack).toBeInstanceOf(StateStack);
    expect(grandchildBranch.stack.stack[0].args).toEqual({
      level: "grandchild",
    });
    expect(grandchildBranch.stack.stack[0].step).toBe(1);
  });

  it("deep clone independence: mutating live child does not affect serialized version", () => {
    const childStack = new StateStack(
      [makeFrame({ args: { val: 10 }, locals: { tmp: "original" }, step: 0 })],
      "serialize",
    );

    const parentFrame = makeFrame({
      branches: {
        0: { stack: childStack },
      },
    });
    const parentStack = new StateStack([parentFrame], "serialize");

    // Serialize
    const json = parentStack.toJSON();

    // Mutate the live child stack
    childStack.stack[0].args.val = 999;
    childStack.stack[0].locals.tmp = "mutated";
    childStack.stack.push(makeFrame({ args: { extra: true } }));

    // The serialized JSON should be unaffected
    const serializedChild = (json.stack[0] as any).branches["0"].stack;
    expect(serializedChild.stack).toHaveLength(1);
    expect(serializedChild.stack[0].args.val).toBe(10);
    expect(serializedChild.stack[0].locals.tmp).toBe("original");
  });

  it("toJSON omits branches when not present on a frame", () => {
    const stack = new StateStack(
      [makeFrame({ args: { simple: true }, step: 5 })],
      "serialize",
    );
    const json = stack.toJSON();
    expect((json.stack[0] as any).branches).toBeUndefined();
  });

  it("toJSON omits interruptId and interruptData when not set", () => {
    const childStack = new StateStack([makeFrame()], "serialize");
    const parentFrame = makeFrame({
      branches: {
        0: { stack: childStack },
      },
    });
    const parentStack = new StateStack([parentFrame], "serialize");
    const json = parentStack.toJSON();

    const branch = (json.stack[0] as any).branches["0"];
    expect(branch.interruptId).toBeUndefined();
    expect(branch.interruptData).toBeUndefined();
  });

  it("serializes and deserializes BranchState.result", () => {
    const stack = new StateStack();
    const frame = stack.getNewState();
    // Use the public branch helpers to set up the test fixture so we don't
    // have to poke at the private `branches` field directly.
    frame.newBranch("fork_0_0");
    frame.setResultOnBranch("fork_0_0", "hello");
    frame.newBranch("fork_0_1");
    // fork_0_1: no result — thread still interrupted
    frame.newBranch("fork_0_2");
    frame.setResultOnBranch("fork_0_2", undefined); // thread returned undefined

    const json = stack.toJSON();
    const restored = StateStack.fromJSON(json);
    const restoredFrame = restored.stack[0];

    expect(restoredFrame.getBranch("fork_0_0")!.result).toEqual({
      result: "hello",
    });
    expect(restoredFrame.getBranch("fork_0_1")!.result).toBeUndefined();
    expect(restoredFrame.getBranch("fork_0_2")!.result).toEqual({
      result: undefined,
    });
  });
});

describe("advanceDebugStep", () => {
  it("increments stack.step for a top-level stepPath", () => {
    const stack = new StateStack([makeFrame({ step: 3 })]);
    stack.advanceDebugStep("3");
    expect(stack.lastFrame().step).toBe(4);
  });

  it("sets substep counter for a two-segment stepPath", () => {
    const stack = new StateStack([makeFrame({ step: 4, locals: {} })]);
    stack.advanceDebugStep("4.0");
    // Should set __substep_4 = 0 + 1 = 1
    expect(stack.lastFrame().locals.__substep_4).toBe(1);
    // step should NOT be incremented
    expect(stack.lastFrame().step).toBe(4);
  });

  it("sets substep counter for a three-segment stepPath", () => {
    const stack = new StateStack([makeFrame({ step: 4, locals: {} })]);
    stack.advanceDebugStep("4.0.2");
    // Should set __substep_4.0 = 2 + 1 = 3
    expect((stack.lastFrame().locals as any)["__substep_4.0"]).toBe(3);
    expect(stack.lastFrame().step).toBe(4);
  });

  it("does nothing if no frame exists", () => {
    const stack = new StateStack([]);
    // Should not throw
    stack.advanceDebugStep("0");
  });
});

describe("StateStack localCost/localTokens/seedCost serialization", () => {
  it("defaults to 0 on a fresh stack", () => {
    const stack = new StateStack();
    expect(stack.localCost).toBe(0);
    expect(stack.localTokens).toBe(0);
    expect(stack.seedCost).toBe(0);
    expect(stack.seedTokens).toBe(0);
  });

  it("round-trips localCost/localTokens/seedCost/seedTokens through toJSON/fromJSON", () => {
    const stack = new StateStack();
    stack.localCost = 3.5;
    stack.localTokens = 200;
    stack.seedCost = 1.25;
    stack.seedTokens = 75;
    const json = stack.toJSON();
    expect(json.localCost).toBe(3.5);
    expect(json.localTokens).toBe(200);
    expect(json.seedCost).toBe(1.25);
    expect(json.seedTokens).toBe(75);

    const restored = StateStack.fromJSON(json);
    expect(restored.localCost).toBe(3.5);
    expect(restored.localTokens).toBe(200);
    expect(restored.seedCost).toBe(1.25);
    expect(restored.seedTokens).toBe(75);
  });

  it("fromJSON defaults missing fields to 0 (backward compat with old checkpoints)", () => {
    const json = {
      stack: [],
      mode: "serialize" as const,
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    };
    const restored = StateStack.fromJSON(json);
    expect(restored.localCost).toBe(0);
    expect(restored.localTokens).toBe(0);
    expect(restored.seedCost).toBe(0);
    expect(restored.seedTokens).toBe(0);
  });
});

describe("State.scopedCallbacks", () => {
  it("defaults to undefined when no callbacks are registered", () => {
    expect(new State().scopedCallbacks).toBeUndefined();
  });

  it("addScopedCallback initializes the array lazily and appends", () => {
    const state = new State();
    const fn = () => {};
    state.addScopedCallback("onNodeStart", fn);
    state.addScopedCallback("onNodeEnd", fn);
    expect(state.scopedCallbacks).toEqual([
      { name: "onNodeStart", fn },
      { name: "onNodeEnd", fn },
    ]);
  });

  it("toJSON/fromJSON round-trip preserves scopedCallbacks (in-memory)", () => {
    // Verifies State.toJSON/fromJSON pass-through. Full JSON-string round-trip
    // through nativeTypeReplacer is exercised by the Agency-level resume test
    // (callback-resume.agency), where fn is a real AgencyFunction.
    const state = new State();
    const fn = () => {};
    state.addScopedCallback("onNodeStart", fn);
    const restored = State.fromJSON(state.toJSON());
    expect(restored.scopedCallbacks).toHaveLength(1);
    expect(restored.scopedCallbacks![0].name).toBe("onNodeStart");
    expect(restored.scopedCallbacks![0].fn).toBe(fn);
  });

  it("does not include scopedCallbacks in JSON when empty", () => {
    expect(new State().toJSON().scopedCallbacks).toBeUndefined();
  });
});

describe("StateStack.callerFrame / collectScopedCallbacks", () => {
  function stackWithFrames(n: number): StateStack {
    const stack = new StateStack();
    for (let i = 0; i < n; i++) stack.stack.push(new State());
    return stack;
  }

  it("callerFrame returns the second-from-top frame when stack has >= 2 frames", () => {
    const stack = stackWithFrames(2);
    expect(stack.callerFrame()).toBe(stack.stack[0]);
  });

  it("callerFrame falls back to the root frame when stack has 1 frame", () => {
    const stack = stackWithFrames(1);
    expect(stack.callerFrame()).toBe(stack.stack[0]);
  });

  it("callerFrame throws when stack is empty", () => {
    expect(() => new StateStack().callerFrame()).toThrow();
  });

  it("collectScopedCallbacks returns innermost → outermost matching the name", () => {
    const stack = stackWithFrames(3);
    const a = () => {};
    const b = () => {};
    const c = () => {};
    stack.stack[0].addScopedCallback("onNodeStart", a); // outermost
    stack.stack[1].addScopedCallback("onNodeStart", b);
    stack.stack[1].addScopedCallback("onNodeEnd", () => {}); // wrong name, ignored
    stack.stack[2].addScopedCallback("onNodeStart", c); // innermost
    expect(stack.collectScopedCallbacks("onNodeStart")).toEqual([c, b, a]);
  });

  it("collectScopedCallbacks preserves registration order within a single frame", () => {
    const stack = stackWithFrames(1);
    const a = () => {};
    const b = () => {};
    const c = () => {};
    stack.stack[0].addScopedCallback("onNodeStart", a);
    stack.stack[0].addScopedCallback("onNodeStart", b);
    stack.stack[0].addScopedCallback("onNodeStart", c);
    expect(stack.collectScopedCallbacks("onNodeStart")).toEqual([a, b, c]);
  });

  it("collectScopedCallbacks combines same-frame and cross-frame ordering", () => {
    // Frame layout: outer has two callbacks; inner has one. Result is
    // inner's callback first, then outer's two in registration order.
    const stack = stackWithFrames(2);
    const a = () => {};
    const b = () => {};
    const c = () => {};
    stack.stack[0].addScopedCallback("onNodeStart", a);
    stack.stack[0].addScopedCallback("onNodeStart", b);
    stack.stack[1].addScopedCallback("onNodeStart", c);
    expect(stack.collectScopedCallbacks("onNodeStart")).toEqual([c, a, b]);
  });

  it("collectScopedCallbacks returns empty when nothing matches", () => {
    expect(stackWithFrames(2).collectScopedCallbacks("onNodeStart")).toEqual([]);
  });
});

describe("StateStack.isGlobalContext", () => {
  function stackWithFrames(n: number): StateStack {
    const stack = new StateStack();
    for (let i = 0; i < n; i++) stack.stack.push(new State());
    return stack;
  }

  it("returns true when stack is empty (defensive)", () => {
    expect(new StateStack().isGlobalContext()).toBe(true);
  });

  it("returns true when only the callback's own frame is on the stack (top-level)", () => {
    // When `callback(...)` runs at module top-level (inside __initializeGlobals),
    // the only frame on the stack is `callback`'s own. There is no real caller.
    expect(stackWithFrames(1).isGlobalContext()).toBe(true);
  });

  it("returns false when there is a real caller frame", () => {
    expect(stackWithFrames(2).isGlobalContext()).toBe(false);
    expect(stackWithFrames(5).isGlobalContext()).toBe(false);
  });
});

describe("_callback", () => {
  function ctxWithFrames(n: number): any {
    const stack = new StateStack();
    for (let i = 0; i < n; i++) stack.stack.push(new State());
    return { stateStack: stack, topLevelCallbacks: [] };
  }

  it("registers on the caller frame when stack has >= 2 frames", () => {
    const ctx = ctxWithFrames(2); // [caller, callback's own frame]
    const fn = () => {};
    callCallback(ctx, "onNodeStart", fn);
    expect(ctx.stateStack.stack[0].scopedCallbacks).toEqual([
      { name: "onNodeStart", fn },
    ]);
    expect(ctx.stateStack.stack[1].scopedCallbacks).toBeUndefined();
    expect(ctx.topLevelCallbacks).toEqual([]);
  });

  it("routes to ctx.topLevelCallbacks when stack length <= 1 (module init)", () => {
    const ctx = ctxWithFrames(1); // only callback's own frame — top level
    const fn = () => {};
    callCallback(ctx, "onNodeStart", fn);
    expect(ctx.topLevelCallbacks).toEqual([{ name: "onNodeStart", fn }]);
    expect(ctx.stateStack.stack[0].scopedCallbacks).toBeUndefined();
  });

  it("routes to ctx.topLevelCallbacks when stack is empty (defensive)", () => {
    const ctx = ctxWithFrames(0);
    callCallback(ctx, "onNodeStart", () => {});
    expect(ctx.topLevelCallbacks).toHaveLength(1);
  });

  it("throws on unknown callback name", () => {
    const ctx = ctxWithFrames(2);
    expect(() =>
      callCallback(ctx, "notAHook", () => {}),
    ).toThrow(/Unknown callback/);
  });

  it("throws when fn is a string (non-callable)", () => {
    const ctx = ctxWithFrames(2);
    expect(() =>
      callCallback(ctx, "onNodeStart", "not a function" as any),
    ).toThrow(/must be a function/i);
  });

  it("throws when fn is a number (non-callable)", () => {
    const ctx = ctxWithFrames(2);
    expect(() =>
      callCallback(ctx, "onNodeStart", 42 as any),
    ).toThrow(/must be a function/i);
  });

  it("throws when fn is null", () => {
    const ctx = ctxWithFrames(2);
    expect(() =>
      callCallback(ctx, "onNodeStart", null as any),
    ).toThrow(/must be a function/i);
  });

  it("throws when fn is undefined", () => {
    const ctx = ctxWithFrames(2);
    expect(() =>
      callCallback(ctx, "onNodeStart", undefined as any),
    ).toThrow(/must be a function/i);
  });

  it("accepts a plain function", () => {
    const ctx = ctxWithFrames(2);
    const fn = (_data: any) => {};
    expect(() =>
      callCallback(ctx, "onNodeStart", fn),
    ).not.toThrow();
  });
});

describe("StateStack guards", () => {
  it("pushGuard appends and popGuard removes from the end", () => {
    const stack = new StateStack();
    expect(stack.guards).toEqual([]);
    const a = new CostGuard(1.0);
    const b = new CostGuard(2.0);
    stack.localCost = 0.5;
    stack.pushGuard(a);
    stack.pushGuard(b);
    expect(stack.guards).toHaveLength(2);
    const popped = stack.popGuard();
    expect(popped).toBe(b);
    expect(stack.guards).toHaveLength(1);
    expect(stack.guards[0]).toBe(a);
  });

  it("popGuard on empty stack returns undefined", () => {
    const stack = new StateStack();
    expect(stack.popGuard()).toBeUndefined();
  });

  it("toJSON / fromJSON preserves guards", () => {
    const stack = new StateStack();
    const g1 = new CostGuard(1.5);
    stack.pushGuard(g1);
    g1.charge(0.2);
    const g2 = new CostGuard(0.5);
    stack.pushGuard(g2);
    g2.charge(0.4);
    const json = stack.toJSON();
    expect(json.guards).toEqual([
      { kind: "cost", costLimit: 1.5, spent: 0.2 },
      { kind: "cost", costLimit: 0.5, spent: 0.4 },
    ]);
    const restored = StateStack.fromJSON(json);
    expect(restored.guards).toHaveLength(2);
    expect(restored.guards[0]).toBeInstanceOf(CostGuard);
    expect((restored.guards[0] as CostGuard).costLimit).toBe(1.5);
    expect((restored.guards[1] as CostGuard).costLimit).toBe(0.5);
  });

  it("fromJSON defaults guards to [] when the field is absent (pre-guard checkpoints)", () => {
    const json: any = {
      stack: [],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    };
    const restored = StateStack.fromJSON(json);
    expect(restored.guards).toEqual([]);
  });

  it("pushGuard calls install() and toJSON serializes spent counter", () => {
    const stack = new StateStack();
    const g = new CostGuard(5);
    stack.pushGuard(g);
    g.charge(1.23);
    const json = stack.toJSON();
    expect(json.guards![0]).toEqual({
      kind: "cost",
      costLimit: 5,
      spent: 1.23,
    });
  });
});

describe("StateStack.enforceGuards", () => {
  it("is a no-op when no guards are present", () => {
    const stack = new StateStack();
    expect(() => stack.enforceGuards()).not.toThrow();
  });

  it("is a no-op when every guard is below its limit", () => {
    const stack = new StateStack();
    const g = new CostGuard(5);
    stack.pushGuard(g);
    g.charge(2);
    expect(() => stack.enforceGuards()).not.toThrow();
  });

  it("throws the trip error from the innermost (last-pushed) guard first", () => {
    // Innermost-first order is the contract — a deeper guard with a
    // tighter budget should report its trip before a shallower outer.
    const stack = new StateStack();
    const outer = new CostGuard(10);
    stack.pushGuard(outer);
    const inner = new CostGuard(1);
    stack.pushGuard(inner);
    outer.charge(11); // outer is over too
    inner.charge(2); // inner is over
    try {
      stack.enforceGuards();
      throw new Error("expected enforceGuards to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardExceededError);
      const e = err as GuardExceededError;
      // Inner's limit is 1, not outer's 10 — proves innermost-first.
      expect(e.limit).toBe(1);
    }
  });
});

describe("StateStack.chargeGuards", () => {
  it("calls charge(amount) on every guard", () => {
    const stack = new StateStack();
    const g1 = new CostGuard(5);
    const g2 = new CostGuard(5);
    stack.pushGuard(g1);
    stack.pushGuard(g2);
    stack.chargeGuards(1.5);
    // Charging makes both guards' spent = 1.5; verify via check() at
    // the boundary.
    g1.charge(3.6); // 1.5 + 3.6 = 5.1 > 5
    expect(g1.check(stack)?.spent).toBeCloseTo(5.1, 5);
    g2.charge(3.6);
    expect(g2.check(stack)?.spent).toBeCloseTo(5.1, 5);
  });

  it("is a no-op when no guards are present", () => {
    const stack = new StateStack();
    expect(() => stack.chargeGuards(1)).not.toThrow();
  });
});

describe("StateStack.rehydrateInheritedGuardsFrom", () => {
  it("prepends parent guards via cloneForBranch on a fresh child", () => {
    const parent = new StateStack();
    const g = new CostGuard(5);
    parent.pushGuard(g);
    const child = new StateStack();

    child.rehydrateInheritedGuardsFrom(parent);

    expect(child.guards).toHaveLength(1);
    expect(child.guards[0]).toBe(g); // shared reference
    expect(child.inheritedGuardCount).toBe(1);
  });

  it("preserves branch-owned guards by prepending parent guards in front", () => {
    const parent = new StateStack();
    const outer = new CostGuard(10);
    parent.pushGuard(outer);

    const child = new StateStack();
    const inner = new CostGuard(2);
    // Simulate a resumed child where the inner was deserialized first.
    child.guards = [inner];

    child.rehydrateInheritedGuardsFrom(parent);

    expect(child.guards).toHaveLength(2);
    expect(child.guards[0]).toBe(outer); // inherited first
    expect(child.guards[1]).toBe(inner); // own preserved
    expect(child.inheritedGuardCount).toBe(1);
  });

  it("validates persisted inheritedGuardCount on resume; throws on mismatch", () => {
    // On resume, the child's `inheritedGuardCount` was restored from
    // JSON. If the parent's guards array has drifted (e.g. the parent
    // pushed an extra guard between snapshot and resume), the recomputed
    // inheritedRefs length won't match the persisted count and we throw
    // — silently inheriting a different set of guards would be a
    // correctness bug far from its source.
    const parent = new StateStack();
    const outer = new CostGuard(10);
    parent.pushGuard(outer);
    const newer = new CostGuard(20);
    parent.pushGuard(newer);

    const child = new StateStack();
    child.inheritedGuardCount = 1; // snapshot said 1, parent now yields 2

    expect(() => child.rehydrateInheritedGuardsFrom(parent)).toThrow(
      /inheritedGuardCount/,
    );
  });

  it("filters out guards whose cloneForBranch returns undefined", () => {
    // TimeGuard returns undefined from cloneForBranch — the parent's
    // timer is the single source of truth, no branch ref needed. The
    // child's inheritedGuardCount must reflect the number actually
    // prepended (zero, in the all-TimeGuards case).
    const parent = new StateStack();
    // Pretend-time-guard that returns undefined from cloneForBranch.
    const ignored: any = {
      cloneForBranch: () => undefined,
    };
    parent.guards = [ignored];
    const child = new StateStack();

    child.rehydrateInheritedGuardsFrom(parent);

    expect(child.guards).toEqual([]);
    expect(child.inheritedGuardCount).toBe(0);
  });
});
