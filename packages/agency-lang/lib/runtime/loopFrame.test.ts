import { describe, it, expect } from "vitest";
import { initLoopFrame } from "./loopFrame.js";

describe("initLoopFrame", () => {
  it("starts a new frame's cut-off counter at 0", () => {
    const self: any = {};
    initLoopFrame(self, {});
    expect(self.cutOffAttempt).toBe(0);
  });

  it("gives an old frame a cut-off counter of 0 and no pending retry", () => {
    const self: any = { __initialized: true, validationAttempt: 1 };
    initLoopFrame(self, {});
    expect(self.cutOffAttempt).toBe(0);
    expect(self.cutOffPending).toBeNull();
    expect(self.lastStopReason).toBeNull();
    expect(self.validationAttempt).toBe(1);
  });
});
