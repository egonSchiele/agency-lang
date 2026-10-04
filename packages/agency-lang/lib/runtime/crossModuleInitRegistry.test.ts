import { describe, it, expect } from "vitest";
import {
  __registerCallbacksInit,
  __initAllRegisteredCallbacks,
} from "./crossModuleInitRegistry.js";
import { runInTestContext, type Run } from "./asyncContext.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

describe("callback registry", () => {
  it("resets the list once, then runs every registered module in registration order", async () => {
    const ctx = makeMockCtx();
    ctx.topLevelCallbacks = ["stale"];

    __registerCallbacksInit("a.agency", async (run: Run) => {
      (run.ctx.topLevelCallbacks as unknown[]).push("a");
    });
    __registerCallbacksInit("b.agency", async (run: Run) => {
      (run.ctx.topLevelCallbacks as unknown[]).push("b");
    });

    await runInTestContext(ctx, ctx.stateStack, ctx.threads, (run) =>
      __initAllRegisteredCallbacks(run),
    );

    // The pre-existing "stale" entry is cleared exactly once, and both
    // modules' registrations survive (no module clobbers another).
    expect(ctx.topLevelCallbacks).toEqual(["a", "b"]);
  });

  it("re-running clears previous registrations before re-registering", async () => {
    // Register inside the test so it passes standalone (.only). The registry
    // is process-global with last-write-wins, so re-registering the same
    // moduleIds as the previous test is harmless.
    __registerCallbacksInit("a.agency", async (run: Run) => {
      (run.ctx.topLevelCallbacks as unknown[]).push("a");
    });
    __registerCallbacksInit("b.agency", async (run: Run) => {
      (run.ctx.topLevelCallbacks as unknown[]).push("b");
    });
    const ctx = makeMockCtx();
    ctx.topLevelCallbacks = ["stale"];
    await runInTestContext(ctx, ctx.stateStack, ctx.threads, (run) =>
      __initAllRegisteredCallbacks(run),
    );
    expect(ctx.topLevelCallbacks).toEqual(["a", "b"]);
  });
});
