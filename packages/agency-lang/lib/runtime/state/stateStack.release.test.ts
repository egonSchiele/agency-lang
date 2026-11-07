import { describe, it, expect } from "vitest";
import { StateStack } from "./stateStack.js";

// A compiled scope removes its own frame at exit. Two scopes can run on one
// stack at once (the parent's handlers for interrupts a subprocess forwards,
// callbacks fired from a child), so the one finishing first must take its own
// frame and leave the other's in place (#1426).
describe("StateStack.release", () => {
  it("removes the frame it is given and leaves the one above it on top", () => {
    const stack = new StateStack();
    const first = stack.getNewState();
    const second = stack.getNewState();

    stack.release(first);

    expect(stack.lastFrame()).toBe(second);
    expect(stack.toJSON().stack).toHaveLength(1);
  });

  it("removes the top frame when the finishing scope is the top", () => {
    const stack = new StateStack();
    const first = stack.getNewState();
    const second = stack.getNewState();

    stack.release(second);

    expect(stack.lastFrame()).toBe(first);
  });

  it("leaves the stack consistent after two interleaved scopes both finish", () => {
    const stack = new StateStack();
    const base = stack.getNewState();
    const first = stack.getNewState();
    const second = stack.getNewState();

    stack.release(first);
    stack.release(second);

    expect(stack.lastFrame()).toBe(base);
  });

  it("throws for a frame that is not on the stack", () => {
    const stack = new StateStack();
    const frame = stack.getNewState();
    stack.release(frame);

    expect(() => stack.release(frame)).toThrow(/not on the stack/);
  });
});
