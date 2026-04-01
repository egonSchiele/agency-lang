import type { Interrupt } from "./interrupts.js";
import { createDebugInterrupt } from "./interrupts.js";
import type { RuntimeContext } from "./state/context.js";
import type { InternalFunctionState } from "./types.js";

export async function debugStep(
  ctx: RuntimeContext<any>,
  state: InternalFunctionState,
  info: {
    moduleId: string;
    scopeName: string;
    stepPath: string;
    label: string | null;
    nodeContext: boolean;
  },
): Promise<Interrupt | undefined> {
  // If resuming from a previous debug pause, the interrupt system sets
  // interruptData.interruptResponse on the state. Clear it so downstream
  // code (e.g., runPrompt) doesn't mistake it for a tool call response.
  // When resuming from a debug interrupt, respondToInterrupt sets
  // interruptData.interruptResponse on the state. Clear it so downstream
  // code (e.g., runPrompt) doesn't mistake it for a tool call response.
  if (state.interruptData?.interruptResponse) {
    state.interruptData.interruptResponse = undefined;
  }

  const dbg = ctx.debugger;
  if (!dbg) return undefined;

  // Decide whether to pause
  const isUserBreakpoint = info.label !== null;
  const isStepping = dbg.isStepping();
  const shouldPause = isStepping ? dbg.isAtTargetDepth() : isUserBreakpoint;

  dbg.createRollingCheckpoint(ctx, {
    moduleId: info.moduleId,
    scopeName: info.scopeName,
    stepPath: info.stepPath,
  });

  if (!shouldPause) {
    // Not pausing — just take a rolling checkpoint for rewind history
    return undefined;
  }

  // Advance the step/substep counter before checkpointing so that on resume
  // we skip past this debugStep block and proceed to the next statement.
  ctx.stateStack.advanceDebugStep(info.stepPath);

  // Create a single rolling checkpoint that also serves as the interrupt's checkpoint.
  // No separate pinned checkpoint — avoids duplicate entries in the rewind selector.
  /*   const checkpointId = dbg.createRollingCheckpoint(ctx, {
      moduleId: info.moduleId,
      scopeName: info.scopeName,
      stepPath: info.stepPath,
    });
    
   */

  const checkpointId = ctx.checkpoints.create(ctx, {
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
  );

  return debugInterrupt;
}
