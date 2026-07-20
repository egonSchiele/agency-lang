import { describe, it, expect } from "vitest";
import { StateStack, State } from "./stateStack.js";
import type { HandlerEntry } from "../types.js";

const entry = (): HandlerEntry => ({ fn: async () => undefined, liveGuardIds: [] });

describe("StateStack.executingHandlerEntries", () => {
  it("starts empty and is not serialized", () => {
    const stack = new StateStack();
    expect(stack.executingHandlerEntries).toEqual([]);
    stack.executingHandlerEntries.push(entry());
    expect("executingHandlerEntries" in stack.toJSON()).toBe(false);
    const revived = StateStack.fromJSON(stack.toJSON());
    expect(revived.executingHandlerEntries).toEqual([]);
  });

  it("adoptExecutingHandlersFrom copies a snapshot, not an alias", () => {
    const parent = new StateStack();
    const e = entry();
    parent.executingHandlerEntries.push(e);
    const child = new StateStack();
    child.adoptExecutingHandlersFrom(parent);
    expect(child.executingHandlerEntries).toEqual([e]);
    expect(child.executingHandlerEntries[0]).toBe(e); // entry objects are copied by reference, not cloned
    parent.executingHandlerEntries.pop();
    expect(child.executingHandlerEntries).toEqual([e]); // parent pop does not reach the child
  });

  it("assertNoExecutingHandlers passes on a clean stack with frames", () => {
    const stack = new StateStack();
    stack.stack.push(new State());
    expect(() => stack.assertNoExecutingHandlers()).not.toThrow();
  });

  it("assertNoExecutingHandlers throws when the top-level list is non-empty", () => {
    const stack = new StateStack();
    stack.executingHandlerEntries.push(entry());
    expect(() => stack.assertNoExecutingHandlers()).toThrow(/handler function is executing/);
  });

  it("assertNoExecutingHandlers finds a mark on a nested branch under an unmarked parent", () => {
    const stack = new StateStack();
    const frame = new State();
    stack.stack.push(frame);
    const branch = frame.newBranch("tool_x");
    branch.stack.executingHandlerEntries.push(entry());
    expect(() => stack.assertNoExecutingHandlers()).toThrow(/handler function is executing/);
  });
});
