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

    it("running clears stepTarget", () => {
      const state = new DebuggerState(10);
      state.stepNext();
      expect(state.isAtTargetDepth()).toBe(true); // target = 0, depth = 0
      state.running();
      // After running(), stepTarget is null, so isAtTargetDepth returns true
      expect(state.isAtTargetDepth()).toBe(true);
    });
  });

  describe("call depth", () => {
    it("starts at depth 0", () => {
      const state = new DebuggerState(10);
      // At depth 0 with no target, isAtTargetDepth is true
      expect(state.isAtTargetDepth()).toBe(true);
    });

    it("enterCall increments depth", () => {
      const state = new DebuggerState(10);
      state.stepNext(); // target = 0
      state.enterCall();
      // depth = 1, target = 0 → not at target
      expect(state.isAtTargetDepth()).toBe(false);
    });

    it("exitCall decrements depth", () => {
      const state = new DebuggerState(10);
      state.enterCall();
      state.enterCall();
      state.stepNext(); // target = 2
      state.exitCall();
      // depth = 1, target = 2 → not at target
      expect(state.isAtTargetDepth()).toBe(false);
    });

    it("exitCall does not go below 0", () => {
      const state = new DebuggerState(10);
      state.exitCall();
      state.stepNext(); // target = 0
      expect(state.isAtTargetDepth()).toBe(true);
    });

    it("resetCallDepth resets to 0", () => {
      const state = new DebuggerState(10);
      state.enterCall();
      state.enterCall();
      state.resetCallDepth();
      state.stepNext(); // target = 0
      expect(state.isAtTargetDepth()).toBe(true);
    });
  });

  describe("step targeting", () => {
    it("stepIn targets callDepth + 1", () => {
      const state = new DebuggerState(10);
      state.stepIn(); // target = 1
      // depth = 0, target = 1 → not at target
      expect(state.isAtTargetDepth()).toBe(false);
      state.enterCall(); // depth = 1
      expect(state.isAtTargetDepth()).toBe(true);
    });

    it("stepNext targets current callDepth", () => {
      const state = new DebuggerState(10);
      state.enterCall();
      state.stepNext(); // target = 1
      expect(state.isAtTargetDepth()).toBe(true);
      state.enterCall(); // depth = 2
      expect(state.isAtTargetDepth()).toBe(false);
    });

    it("stepOut targets callDepth - 1", () => {
      const state = new DebuggerState(10);
      state.enterCall();
      state.enterCall(); // depth = 2
      state.stepOut(); // target = 1
      expect(state.isAtTargetDepth()).toBe(false);
      state.exitCall(); // depth = 1
      expect(state.isAtTargetDepth()).toBe(true);
    });

    it("isAtTargetDepth returns true when no target is set", () => {
      const state = new DebuggerState(10);
      state.enterCall();
      state.enterCall();
      // No stepTarget set → always true
      expect(state.isAtTargetDepth()).toBe(true);
    });
  });

  describe("reset", () => {
    it("resets call depth and mode to stepping", () => {
      const state = new DebuggerState(10);
      state.running();
      state.enterCall();
      state.enterCall();
      state.reset();
      expect(state.isStepping()).toBe(true);
      state.stepNext(); // target = 0 (verifies depth was reset)
      expect(state.isAtTargetDepth()).toBe(true);
    });
  });
});
