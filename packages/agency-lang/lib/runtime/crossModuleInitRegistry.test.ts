import { describe, it, expect } from "vitest";
import {
  __registerCallbacksInit,
  __initAllRegisteredCallbacks,
} from "./crossModuleInitRegistry.js";

describe("callback registry", () => {
  it("resets the list once, then runs every registered module in registration order", async () => {
    const ctx: { topLevelCallbacks: string[] } = { topLevelCallbacks: ["stale"] };

    __registerCallbacksInit("a.agency", async (target: any) => {
      target.topLevelCallbacks.push("a");
    });
    __registerCallbacksInit("b.agency", async (target: any) => {
      target.topLevelCallbacks.push("b");
    });

    await __initAllRegisteredCallbacks(ctx);

    // The pre-existing "stale" entry is cleared exactly once, and both
    // modules' registrations survive (no module clobbers another).
    expect(ctx.topLevelCallbacks).toEqual(["a", "b"]);
  });

  it("re-running clears previous registrations before re-registering", async () => {
    // Register inside the test so it passes standalone (.only). The registry
    // is process-global with last-write-wins, so re-registering the same
    // moduleIds as the previous test is harmless.
    __registerCallbacksInit("a.agency", async (target: any) => {
      target.topLevelCallbacks.push("a");
    });
    __registerCallbacksInit("b.agency", async (target: any) => {
      target.topLevelCallbacks.push("b");
    });
    const ctx: { topLevelCallbacks: string[] } = { topLevelCallbacks: ["stale"] };
    await __initAllRegisteredCallbacks(ctx);
    expect(ctx.topLevelCallbacks).toEqual(["a", "b"]);
  });
});
