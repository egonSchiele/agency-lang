import { CheckpointError, RestoreSignal } from "./errors.js";
import type { RestoreOptions } from "./errors.js";
import { getRuntimeContext } from "./asyncContext.js";
import type { Checkpoint } from "./state/checkpointStore.js";

/**
 * Capture a checkpoint of the current execution state. The source
 * location attached to the checkpoint (`moduleId` / `scopeName` /
 * `stepPath`) is read from the active `agencyStore` frame's
 * `callsite` slot, which `Runner.runInScope` seeds for every step
 * body. Calls made outside a runner step (e.g. from bootstrap scope)
 * fall back to the empty `""::""::""` location.
 */
export async function checkpoint(): Promise<number> {
  const { ctx, callsite } = getRuntimeContext();
  await ctx.pendingPromises.awaitAll();
  return ctx.checkpoints.create(ctx.stateStack, ctx, {
    moduleId: callsite?.moduleId ?? "",
    scopeName: callsite?.scopeName ?? "",
    stepPath: callsite?.stepPath ?? "",
  });
}

export function getCheckpoint(checkpointId: number): Checkpoint {
  const { ctx } = getRuntimeContext();
  const cp = ctx.checkpoints.get(checkpointId);
  if (!cp)
    throw new CheckpointError(
      `Checkpoint ${checkpointId} does not exist or has been deleted`,
    );
  return cp;
}

export function restore(
  checkpointIdOrCheckpoint: number | Checkpoint,
  options: RestoreOptions,
): void {
  const { ctx } = getRuntimeContext();
  let cp: Checkpoint;
  if (typeof checkpointIdOrCheckpoint === "number") {
    const found = ctx.checkpoints.get(checkpointIdOrCheckpoint);
    if (!found)
      throw new CheckpointError(
        `Checkpoint ${checkpointIdOrCheckpoint} does not exist or has been deleted`,
      );
    cp = found;
  } else {
    cp = checkpointIdOrCheckpoint;
  }

  const location = cp.getLocation();

  if (
    options.maxRestores !== undefined &&
    ctx.checkpoints.getLocationRestoreCount(location) >= options.maxRestores
  ) {
    return;
  }

  ctx.checkpoints.trackRestore(cp.id);
  if (options.maxRestores !== undefined) {
    ctx.checkpoints.trackLocationRestore(location);
  }
  ctx.checkpoints.deleteAfterCheckpoint(cp.id);
  ctx.pendingPromises.clear();
  throw new RestoreSignal(cp, options);
}
