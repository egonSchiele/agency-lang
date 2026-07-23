import { describe, it, expect } from "vitest";
import { StateStack, claimFrameForScope } from "./stateStack.js";

describe("frame scope-name tripwire", () => {
  it("stamps an unstamped frame and accepts a matching re-claim", () => {
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "myFunc");
    expect(frame.scopeName).toBe("myFunc");
    expect(() => claimFrameForScope(frame, "myFunc")).not.toThrow();
  });

  it("throws a named error when a frame is claimed by a different scope", () => {
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "runPrompt");
    expect(() => claimFrameForScope(frame, "searchTools")).toThrow(
      /Resume desync.*searchTools.*runPrompt/s,
    );
  });

  it("refuses to stamp an empty scope name", () => {
    // Not a legacy accommodation: guards the next hand-written claim
    // site whose author forgets a name (Runner defaults scopeName to "",
    // runner.ts — an empty stamp would collide with the real owner).
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "");
    expect(frame.scopeName).toBeNull();
  });

  it("scopeName is always serialized and survives a round trip", () => {
    const stack = new StateStack();
    const claimed = stack.getNewState();
    claimFrameForScope(claimed, "myFunc");
    stack.getNewState(); // second frame, never claimed
    const json = JSON.parse(JSON.stringify(stack.toJSON()));
    expect(json.stack[0].scopeName).toBe("myFunc");
    expect(json.stack[1].scopeName).toBeNull();
    const restored = StateStack.fromJSON(json);
    expect(restored.stack[0].scopeName).toBe("myFunc");
    expect(restored.stack[1].scopeName).toBeNull();
  });

  it("two Runners on one frame do not conflict, because running is not claiming", () => {
    // The finalize shape: the container claimed the frame; the finalize
    // Runner merely runs on it and never calls claimFrameForScope. The
    // design invariant this pins: only claim sites stamp.
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "foo");
    expect(frame.scopeName).toBe("foo");
  });
});
