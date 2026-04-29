import { describe, it, expect } from "vitest";
import { StateStack, State, BranchState } from "./stateStack.js";

function makeFrame(overrides: Partial<State> = {}): State {
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
    expect(frame.branches).toBeDefined();
    expect(frame.branches![0]).toBeDefined();
    expect(frame.branches![0].interruptId).toBe("int-1");

    // The branch stack should be a live StateStack instance
    const childStack = frame.branches![0].stack;
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
    const childBranch = restored.stack[0].branches![0];
    expect(childBranch.interruptId).toBe("top-interrupt");
    expect(childBranch.stack).toBeInstanceOf(StateStack);
    expect(childBranch.stack.stack[0].args).toEqual({ level: "child" });

    // Verify grandchild
    const grandchildBranch = childBranch.stack.stack[0].branches![0];
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
    frame.branches = {
      "fork_0_0": {
        stack: new StateStack(),
        result: { result: "hello" },
      },
      "fork_0_1": {
        stack: new StateStack(),
        // no result — thread still interrupted
      },
      "fork_0_2": {
        stack: new StateStack(),
        result: { result: undefined }, // thread returned undefined
      },
    };

    const json = stack.toJSON();
    const restored = StateStack.fromJSON(json);
    const restoredFrame = restored.stack[0];

    expect(restoredFrame.branches!["fork_0_0"].result).toEqual({ result: "hello" });
    expect(restoredFrame.branches!["fork_0_1"].result).toBeUndefined();
    expect(restoredFrame.branches!["fork_0_2"].result).toEqual({ result: undefined });
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
