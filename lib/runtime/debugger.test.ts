import { describe, it, expect } from "vitest";
import { debugStep } from "./debugger.js";
import { DebuggerState } from "../debugger/debuggerState.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

function makeState(ctx: any) {
  return { ctx } as any;
}

const baseInfo = {
  moduleId: "main.agency",
  scopeName: "main",
  stepPath: "1",
  label: null,
  nodeContext: true,
  isUserAdded: false,
};

describe("debugStep()", () => {
  it("returns undefined when ctx.debugger is null", async () => {
    const ctx = makeMockCtx();
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeUndefined();
  });

  it("returns interrupt when stepping with stepNext at current depth", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext(); // stepping mode, targetDepth === callDepth (both 0)
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeDefined();
    expect(result!.type).toBe("interrupt");
  });

  it("returns undefined when mode is 'running' and no label", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), {
      ...baseInfo,
      label: null,
    });
    expect(result).toBeUndefined();
  });

  it("returns interrupt when mode is 'running' but label is set (user breakpoint)", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), {
      ...baseInfo,
      label: "my-breakpoint",
      isUserAdded: true,
    });
    expect(result).toBeDefined();
    expect(result!.type).toBe("interrupt");
  });

  it("always creates a rolling checkpoint", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });

    // mode is "running" with no label — will NOT pause, but should still create rolling checkpoint
    await debugStep(ctx, makeState(ctx), { ...baseInfo, label: null });
    expect(dbg.getCheckpoints().length).toBe(1);

    // call again with a label — will pause and replace the rolling checkpoint
    // (createRolling deduplicates by location, and both calls share the same stepPath)
    await debugStep(ctx, makeState(ctx), { ...baseInfo, label: "bp", isUserAdded: true });
    // Only 1 rolling checkpoint remains (deduplicated); the interrupt checkpoint
    // goes to ctx.checkpoints, not the debugger state
    expect(dbg.getCheckpoints().length).toBe(1);
  });

  it("respects stepTarget: does NOT pause when callDepth > targetDepth", async () => {
    const dbg = new DebuggerState(10);
    // Set targetDepth=3 by entering 3 calls then calling stepNext
    for (let i = 0; i < 3; i++) dbg.enterCall();
    dbg.stepNext(); // targetDepth = 3
    // Now go deeper: callDepth = 5
    dbg.enterCall();
    dbg.enterCall();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeUndefined();
  });

  it("respects stepTarget: DOES pause when callDepth < targetDepth", async () => {
    const dbg = new DebuggerState(10);
    // Set targetDepth=3 by entering 3 calls then calling stepNext
    for (let i = 0; i < 3; i++) dbg.enterCall();
    dbg.stepNext(); // targetDepth = 3
    // Now go shallower: callDepth = 2
    dbg.exitCall();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeDefined();
    expect(result!.type).toBe("interrupt");
  });

  it("respects stepTarget: DOES pause when callDepth === targetDepth", async () => {
    const dbg = new DebuggerState(10);
    for (let i = 0; i < 3; i++) dbg.enterCall();
    dbg.stepNext(); // targetDepth = 3, callDepth = 3
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeDefined();
    expect(result!.type).toBe("interrupt");
  });

  it("the returned interrupt has debugger: true", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeDefined();
    expect(result!.debugger).toBe(true);
  });

  it("the returned interrupt has checkpointId and checkpoint set", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), baseInfo);
    expect(result).toBeDefined();
    expect(typeof result!.checkpointId).toBe("number");
    expect(result!.checkpoint).toBeDefined();
    expect(result!.checkpoint!.pinned).toBe(false);
  });

  it("the interrupt data is the label when label is set", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), {
      ...baseInfo,
      label: "my-label",
      isUserAdded: true,
    });
    expect(result).toBeDefined();
    expect(result!.data).toBe("my-label");
  });

  it("the interrupt data is undefined when no label (stepping mode)", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStep(ctx, makeState(ctx), {
      ...baseInfo,
      label: null,
    });
    expect(result).toBeDefined();
    expect(result!.data).toBeUndefined();
  });
});
