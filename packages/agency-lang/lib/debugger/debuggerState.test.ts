import { describe, it, expect } from "vitest";
import { DebuggerState } from "./debuggerState.js";

describe("DebuggerState", () => {
  describe("mode", () => {
    it("starts in stepping mode", () => {
      const state = new DebuggerState(10);
      expect(state.isStepping()).toBe(true);
      expect(state.isRunning()).toBe(false);
      expect(state.getMode()).toBe("stepping");
    });

    it("switches to running mode", () => {
      const state = new DebuggerState(10);
      state.running();
      expect(state.isRunning()).toBe(true);
      expect(state.isStepping()).toBe(false);
    });

    it("switches back to stepping mode", () => {
      const state = new DebuggerState(10);
      state.running();
      state.stepping();
      expect(state.isStepping()).toBe(true);
    });

    it("running clears the step target", () => {
      const state = new DebuggerState(10);
      state.stoppedAt(0);
      state.stepNext();
      expect(state.shouldStopAt(1)).toBe(false);
      state.running();
      expect(state.shouldStopAt(1)).toBe(true);
    });
  });

  // Depth comes from the stack: the node's statements are at 0, a called
  // function's at 1, a tool's statements at 2 (under the runPrompt frame).
  describe("step targeting", () => {
    it("step stops at any depth", () => {
      const state = new DebuggerState(10);
      state.stoppedAt(0);
      state.stepping();
      expect(state.shouldStopAt(0)).toBe(true);
      expect(state.shouldStopAt(2)).toBe(true);
    });

    it("next stops at the depth it stopped at and above, not below", () => {
      const state = new DebuggerState(10);
      state.stoppedAt(2);
      state.stepNext();
      expect(state.shouldStopAt(2)).toBe(true);
      expect(state.shouldStopAt(3)).toBe(false);
      expect(state.shouldStopAt(0)).toBe(true);
    });

    it("step in stops one level deeper", () => {
      const state = new DebuggerState(10);
      state.stoppedAt(0);
      state.stepIn();
      expect(state.shouldStopAt(1)).toBe(true);
      expect(state.shouldStopAt(2)).toBe(false);
    });

    it("step out stops one level up", () => {
      const state = new DebuggerState(10);
      state.stoppedAt(2);
      state.stepOut();
      expect(state.shouldStopAt(2)).toBe(false);
      expect(state.shouldStopAt(1)).toBe(true);
    });

    it("the next stop sets the depth the following command works from", () => {
      const state = new DebuggerState(10);
      state.stoppedAt(0);
      state.stepIn();
      state.stoppedAt(1);
      state.stepNext();
      expect(state.shouldStopAt(1)).toBe(true);
      expect(state.shouldStopAt(2)).toBe(false);
    });
  });

  describe("reset", () => {
    it("resets the stop depth and the mode", () => {
      const state = new DebuggerState(10);
      state.running();
      state.stoppedAt(3);
      state.reset();
      expect(state.isStepping()).toBe(true);
      expect(state.stopDepth).toBe(0);
    });
  });
});
