import { describe, it, expect } from "vitest";
import { debugStep } from "./debugger.js";
import { DebuggerState } from "../debugger/debuggerState.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";
import { runInTestContext } from "./asyncContext.js";
import { withCallDepth } from "./callDepth.js";
import { StateStack } from "./state/stateStack.js";

const baseInfo = {
  moduleId: "main.agency",
  scopeName: "main",
  stepPath: "1",
  label: null,
  nodeContext: true,
  isUserAdded: false,
};

/** Run debugStep under a frame built from the test's own ctx, on the
 *  ctx's root stack, `depth` Agency calls deep. */
function debugStepIn(ctx: any, info: Parameters<typeof debugStep>[1], depth = 0) {
  return runInTestContext(ctx, ctx.stateStack, ctx.threads, (run) =>
    atDepth(run, depth, (deeper) => debugStep(deeper, info, ctx.stateStack)),
  );
}

/** Call `fn` under `depth` nested Agency calls. */
function atDepth<T>(run: any, depth: number, fn: (run: any) => T): T {
  if (depth === 0) return fn(run);
  return withCallDepth(run, `call${depth}`, (deeper) => atDepth(deeper, depth - 1, fn));
}

describe("debugStep()", () => {
  it("returns undefined when ctx.debugger is null", async () => {
    const ctx = makeMockCtx();
    const result = await debugStepIn(ctx, baseInfo);
    expect(result).toBeUndefined();
  });

  it("skips only the first trace checkpoint after rewind", async () => {
    const ctx = makeMockCtx();
    let writes = 0;
    ctx._skipNextCheckpoint = true;
    ctx.writeCheckpointToTraceWriter = async () => {
      writes++;
    };

    await debugStepIn(ctx, baseInfo);
    await debugStepIn(ctx, { ...baseInfo, stepPath: "2" });

    expect(writes).toBe(1);
    expect(ctx._skipNextCheckpoint).toBe(false);
  });

  it("returns interrupt when stepping with stepNext at current depth", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext(); // stepping mode, targetDepth === callDepth (both 0)
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, baseInfo);
    expect(result).toBeDefined();
    expect(result![0].type).toBe("interrupt");
  });

  it("returns undefined when mode is 'running' and no label", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, {
      ...baseInfo,
      label: null,
    });
    expect(result).toBeUndefined();
  });

  it("returns interrupt when mode is 'running' but label is set (user breakpoint)", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, {
      ...baseInfo,
      label: "my-breakpoint",
      isUserAdded: true,
    });
    expect(result).toBeDefined();
    expect(result![0].type).toBe("interrupt");
  });

  it("always creates a rolling checkpoint", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });

    // mode is "running" with no label — will NOT pause, but should still create rolling checkpoint
    await debugStepIn(ctx, { ...baseInfo, label: null });
    expect(dbg.getCheckpoints().length).toBe(1);

    // call again with a label — will pause and replace the rolling checkpoint
    // (createRolling deduplicates by location, and both calls share the same stepPath)
    await debugStepIn(ctx, { ...baseInfo, label: "bp", isUserAdded: true });
    // Only 1 rolling checkpoint remains (deduplicated); the interrupt checkpoint
    // goes to ctx.checkpoints, not the debugger state
    expect(dbg.getCheckpoints().length).toBe(1);
  });

  // The depth of a step is how many Agency calls deep the run is.
  it("does not pause at a step deeper than the target", async () => {
    const dbg = new DebuggerState(10);
    dbg.stoppedAt(3);
    dbg.stepNext(); // target 3
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, baseInfo, 5);
    expect(result).toBeUndefined();
  });

  it("pauses at a step above the target", async () => {
    const dbg = new DebuggerState(10);
    dbg.stoppedAt(3);
    dbg.stepNext(); // target 3
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, baseInfo, 2);
    expect(result).toBeDefined();
    expect(result![0].type).toBe("interrupt");
  });

  it("pauses at a step at the target depth, and the stop record carries the depth", async () => {
    const dbg = new DebuggerState(10);
    dbg.stoppedAt(3);
    dbg.stepNext(); // target 3
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, baseInfo, 3);
    expect(result).toBeDefined();
    expect(result![0].type).toBe("interrupt");
    expect(result![0].data.depth).toBe(3);
    // The driver sets the debugger's depth from the stop it shows, since
    // several branches can stop at once.
    expect(dbg.stopDepth).toBe(3);
  });

  it("the returned interrupt has debugger: true", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, baseInfo);
    expect(result).toBeDefined();
    expect(result![0].debugger).toBe(true);
  });

  it("the returned interrupt has checkpointId and checkpoint set", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, baseInfo);
    expect(result).toBeDefined();
    expect(typeof result![0].checkpointId).toBe("number");
    expect(result![0].checkpoint).toBeDefined();
    expect(result![0].checkpoint!.pinned).toBe(false);
  });

  it("the interrupt data says where the stop is, with the label", async () => {
    const dbg = new DebuggerState(10);
    dbg.running();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, {
      ...baseInfo,
      label: "my-label",
      isUserAdded: true,
    });
    expect(result).toBeDefined();
    expect(result![0].data).toEqual({
      moduleId: "main.agency",
      scopeName: "main",
      stepPath: "1",
      branchPath: [],
      depth: 0,
      label: "my-label",
    });
  });

  it("a loop stop is marked on the stop record and on both checkpoints", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepping();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, {
      ...baseInfo,
      stepPath: "1/initialLlmCall",
      label: "round 1",
      loopStop: "round",
    });
    expect(result![0].data).toMatchObject({ loopStop: "round", label: "round 1" });
    expect(result![0].checkpoint!.loopStop).toBe("round");
    expect(dbg.getCheckpoints()[0].loopStop).toBe("round");
    expect(JSON.stringify(dbg.getCheckpoints()[0].toJSON())).toContain('"loopStop":"round"');
  });

  it("the interrupt data carries a null label when there is none", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const result = await debugStepIn(ctx, {
      ...baseInfo,
      label: null,
    });
    expect(result).toBeDefined();
    expect(result![0].data.label).toBeNull();
  });

  it("names the branch in the stop record, and the halting checkpoint is the branch stack's own", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    const root = new StateStack();
    root.getNewState();
    ctx.stateStack.parent = { stack: root, key: "tool_0_abc" };
    const result = await debugStepIn(ctx, baseInfo);
    expect(result).toBeDefined();
    expect(result![0].data.branchPath).toEqual(["tool_0_abc"]);
    // The checkpoint holds the branch stack itself, so its frame is that
    // stack's last one and it records no path.
    expect(result![0].checkpoint!.branchPath).toEqual([]);
  });

  it("calls the context's refreshers before building a checkpoint", async () => {
    const dbg = new DebuggerState(10);
    dbg.stepNext();
    const ctx = makeMockCtx({ debuggerState: dbg });
    ctx.stateStack.lastFrame().locals.messagesJSON = "stale";
    ctx.beforeCheckpoint.push(() => {
      ctx.stateStack.lastFrame().locals.messagesJSON = "fresh";
    });
    const result = await debugStepIn(ctx, baseInfo);
    expect(result![0].checkpoint!.getCurrentFrame()!.locals.messagesJSON).toBe("fresh");
    expect(dbg.getCheckpoints()[0].getCurrentFrame()!.locals.messagesJSON).toBe("fresh");
  });
});
