import { CheckpointError, RestoreSignal } from "./errors.js";
import type { RestoreOptions } from "./errors.js";
import { getRuntimeContext } from "./asyncContext.js";
import type { Checkpoint } from "./state/checkpointStore.js";

/**
 * Per-call-site location info passed by codegen as the `state` extras
 * to `checkpoint()`. Post-ALS the trailing positional carries ONLY the
 * location fields (`moduleId` / `scopeName` / `stepPath`) — `ctx` and
 * `stateStack` are read from the active `agencyStore` frame, not from
 * this bag.
 */
type CheckpointLocation = {
  moduleId?: string;
  scopeName?: string;
  stepPath?: string;
};

export async function checkpoint(__state?: CheckpointLocation): Promise<number> {
  const { ctx } = getRuntimeContext();
  await ctx.pendingPromises.awaitAll();
  return ctx.checkpoints.create(ctx.stateStack, ctx, {
    moduleId: __state?.moduleId ?? "",
    scopeName: __state?.scopeName ?? "",
    stepPath: __state?.stepPath ?? "",
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
