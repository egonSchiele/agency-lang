import type { Interrupt } from "./interrupts.js";
import { createDebugInterrupt } from "./interrupts.js";
import { Checkpoint } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { SourceLocation } from "./state/sourceLocation.js";
import type { InternalFunctionState } from "./types.js";

export async function debugStep(
  ctx: RuntimeContext<any>,
  state: InternalFunctionState,
  info: Omit<SourceLocation, "nodeId"> & {
    label: string | null;
    nodeContext: boolean;
    isUserAdded: boolean;
  },
): Promise<Interrupt[] | undefined> {
  // Global initialization runs outside any graph node, so there's no node
  // context to create checkpoints against. Skip debugging entirely.
  if (!ctx.stateStack.currentNodeId()) {
    return undefined;
  }

  // Trace write path — independent of debugger
  if (!ctx._skipNextCheckpoint && ctx.stateStack.currentNodeId()) {
    const cp = Checkpoint.fromContext(ctx, info);
    await ctx.writeCheckpointToTraceWriter(cp);
  }

  const dbg = ctx.debuggerState;
  if (!dbg) {
    return undefined;
  }

  // Decide whether to pause
  const isUserBreakpoint = info.isUserAdded;
  const isStepping = dbg.isStepping();

  /* The driver listens for the function start and function end hooks
  and sets the current call depth. Then, when you say "step in,"
  you increase the target depth by one, and if you step out,
  you decrease the target depth by one.

  Here, we ask "Should I stop at the step?" First of all, it's only
  going to stop if you are stepping or there is a user breakpoint,
  like a manually inserted breakpoint in the code. So if you're not
  stepping and you're in continue mode, it's not going to pause until
  it hits an actual breakpoint in the code.

  But if you are stepping, it asks, "Am I at the target depth?" What does
  target depth mean? Well, there are three types of target depth:
  - target depth equals current depth (step)
  - target depth is one less than the current depth (step out)
  - target depth is one greater than the current depth (step in)

  Now, if the target depth is equal to or greater than the current depth—
  so step or step in—there's nothing special to do. You just keep pausing
  at every step, and that'll be the correct thing to do. However, if the
  target depth is *less* than the current depth, that means that you need
  to keep running until the current function you're in returns, and you
  get out of the current depth. That's what this logic does.
  */
  const shouldPause = isStepping
    ? dbg.isAtOrBelowTargetDepth()
    : isUserBreakpoint;

  dbg.createRollingCheckpoint(ctx, {
    moduleId: info.moduleId,
    scopeName: info.scopeName,
    stepPath: info.stepPath,
  });

  if (!shouldPause) {
    // Not pausing — just take a rolling checkpoint for rewind history
    // console.log(`[debugStep] ${isStepping ? "Stepping" : "No breakpoint"} at step ${info.stepPath}, not pausing, continuing execution. call depth: ${dbg.callDepth}, target: ${dbg.stepTarget ? JSON.stringify(dbg.stepTarget) : "n/a"}`);
    return undefined;
  }

  // NOTE: In the old system, advanceDebugStep was called here to skip past
  // the debug step on resume. With the Runner, the debug hook uses a flag
  // in frame.locals (__dbg_<stepPath>) to skip the hook on resume instead,
  // so we no longer advance the step counter here.

  // Create a single rolling checkpoint that also serves as the interrupt's checkpoint.
  // No separate pinned checkpoint — avoids duplicate entries in the rewind selector.
  /*   const checkpointId = dbg.createRollingCheckpoint(ctx, {
      moduleId: info.moduleId,
      scopeName: info.scopeName,
      stepPath: info.stepPath,
    });
    
   */

  const checkpointId = ctx.checkpoints.create(ctx.stateStack, ctx, {
    moduleId: info.moduleId,
    scopeName: info.scopeName,
    stepPath: info.stepPath,
  });
  const checkpoint = ctx.checkpoints.get(checkpointId);

  if (!checkpoint) {
    const debugData = {
      info,
      checkpointId,
    };
    throw new Error(
      `Failed to create debug checkpoint: ${JSON.stringify(debugData)}`,
    );
  }

  const debugInterrupt = createDebugInterrupt(
    info.label ?? undefined,
    checkpointId,
    checkpoint,
    ctx.getRunId(),
  );

  return [debugInterrupt];
}
