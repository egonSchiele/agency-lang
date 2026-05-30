import { describe, it, expect } from "vitest";
import { setupNode } from "../node.js";
import { ThreadStore } from "../state/threadStore.js";
import { StateStack } from "../state/stateStack.js";
import { runInTestContext } from "../asyncContext.js";

// Post-ALS migration: setupNode reads `ctx` from `getRuntimeContext()`,
// not from `state.ctx`. Each test wraps the call in `runInTestContext`
// so the ALS frame is installed before setupNode dereferences it.
describe("setupNode", () => {
  it("uses state.messages ThreadStore when stack.threads is null", () => {
    const threadStore = new ThreadStore();
    threadStore.getOrCreateActive();
    const ctx = { stateStack: new StateStack() } as any;
    const state = { messages: threadStore, ctx, data: {} } as any;

    const result = runInTestContext(ctx, ctx.stateStack, threadStore, () =>
      setupNode({ state }),
    );

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

    const result = runInTestContext(ctx, stateStack, freshThreadStore, () =>
      setupNode({ state }),
    );

    // Should restore from stack.threads, not use state.messages
    expect(result.threads).not.toBe(freshThreadStore);
    expect(result.threads.activeId()).toBeDefined();
  });

  it("falls back to new ThreadStore when neither source is available", () => {
    const ctx = { stateStack: new StateStack() } as any;
    const state = { ctx, data: {} } as any;
    const seedThreads = new ThreadStore();

    const result = runInTestContext(ctx, ctx.stateStack, seedThreads, () =>
      setupNode({ state }),
    );

    expect(result.threads).toBeInstanceOf(ThreadStore);
    expect(result.threads.activeId()).toBeDefined();
  });

  // Task 4: pin the cross-node persistence contract that the thread
  // registry depends on. setupNode reuses the ThreadStore passed via
  // state.messages on every node transition, so any threads created
  // inside an earlier node remain queryable from a later one. If a
  // future refactor of setupNode breaks this branch the registry
  // breaks silently — this test fails fast.
  it("pins the cross-node ThreadStore registry contract", () => {
    const threadStore = new ThreadStore();
    threadStore.getOrCreateActive();           // raw id "0"
    const extraId = threadStore.create();      // raw id "1" — closed thread

    const ctx = { stateStack: new StateStack() } as any;
    const state = { messages: threadStore, ctx, data: {} } as any;

    const result = runInTestContext(ctx, ctx.stateStack, threadStore, () =>
      setupNode({ state }),
    );

    // setupNode must hand back the SAME store, with both threads
    // intact and the counter past them — i.e. nothing has been wiped
    // or rebuilt.
    expect(result.threads).toBe(threadStore);
    expect(Object.keys(result.threads.threads).sort()).toEqual(["0", extraId]);
    expect(result.threads.counter).toBeGreaterThan(Number(extraId));
  });
});
