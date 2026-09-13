import { PauseSignal } from "./errors.js";
import type { Checkpoint, SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import { pausedCheckpointSchema } from "./state/schemas.js";
import type { StateStack } from "./state/stateStack.js";
import type { RunNodeResult } from "./types.js";
import { createReturnObject } from "./utils.js";

/** What a run returns in `data` when a pause request stopped it. The host
 *  stores the whole value and hands it back to `resumeFromCheckpoint`. */
export type PausedCheckpoint = {
  type: "paused";
  checkpoint: Checkpoint;
  runId: string;
};

export function pausedResult(checkpoint: Checkpoint, runId: string): PausedCheckpoint {
  return { type: "paused", checkpoint, runId };
}

export function isPaused(data: unknown): data is PausedCheckpoint {
  return pausedCheckpointSchema.safeParse(data).success;
}

/** Settle a caught pause into the object the caller gets back. The run is
 *  not over, so the trace writer is paused rather than closed, and the
 *  entry that catches the signal emits no agentEnd. */
export async function pausedReturnObject(
  execCtx: RuntimeContext<any>,
  signal: PauseSignal,
): Promise<RunNodeResult<PausedCheckpoint>> {
  if (!execCtx.runId) {
    throw new Error("Paused run has no run id");
  }
  await execCtx.pendingPromises.awaitAll();
  const returnObject = createReturnObject({
    result: { data: pausedResult(signal.checkpoint, execCtx.runId) },
    globals: execCtx.globals,
  });
  await execCtx.pauseTraceWriter();
  return returnObject;
}

type PauseAtStepArgs = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  location: SourceLocationOpts;
};

/** Honour an external pause at a step boundary: stamp a checkpoint here,
 *  record it, clear the request, and unwind with PauseSignal. The step
 *  counter has not advanced, so a resume re-enters this same statement. */
export function pauseAtStep({ ctx, stack, location }: PauseAtStepArgs): never {
  const checkpointId = ctx.checkpoints.create(stack, ctx, location);
  const checkpoint = ctx.checkpoints.get(checkpointId);
  if (!checkpoint) {
    throw new Error(`Pause checkpoint ${checkpointId} was not stored`);
  }
  ctx.statelogClient.checkpointCreated({
    checkpointId,
    reason: "pause",
    sourceLocation: location,
  });
  ctx.pauseRequested = false;
  throw new PauseSignal(checkpoint);
}
