import { describe, it, expect } from "vitest";
import { setupNode } from "../node.js";
import { ThreadStore } from "../state/threadStore.js";
import { StateStack } from "../state/stateStack.js";

describe("setupNode", () => {
  it("uses state.messages ThreadStore when stack.threads is null", () => {
    const threadStore = new ThreadStore();
    threadStore.getOrCreateActive();
    const ctx = { stateStack: new StateStack() } as any;
    const state = { messages: threadStore, ctx, data: {} } as any;

    const result = setupNode({ state });

    expect(result.threads).toBe(threadStore);
    expect(result.threads.activeId()).toBeDefined();
  });

  it("restores from stack.threads when resuming from interrupt", () => {
    const threadStore = new ThreadStore();
    threadStore.getOrCreateActive();
    // Simulate resume: stateStack in deserialize mode with a pre-populated frame
    const stateStack = new StateStack();
    const stack = stateStack.getNewState();
    stack.threads = threadStore.toJSON();
    stateStack.deserializeMode();

    const ctx = { stateStack } as any;
    const freshThreadStore = new ThreadStore();
    const state = { messages: freshThreadStore, ctx, data: {} } as any;

    const result = setupNode({ state });

    // Should restore from stack.threads, not use state.messages
    expect(result.threads).not.toBe(freshThreadStore);
    expect(result.threads.activeId()).toBeDefined();
  });

  it("throws when no ThreadStore is available", () => {
    const ctx = { stateStack: new StateStack() } as any;
    const state = { ctx, data: {} } as any;

    expect(() => setupNode({ state })).toThrow(
      "setupNode: no ThreadStore available",
    );
  });
});
