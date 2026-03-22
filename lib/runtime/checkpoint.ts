import { CheckpointError, RestoreSignal } from "./errors.js";
import type { RestoreOptions } from "./errors.js";
import type { InternalFunctionState } from "./types.js";
import type { Checkpoint } from "./state/checkpointStore.js";

export async function checkpoint(
  __state: InternalFunctionState,
): Promise<number> {
  const ctx = __state.ctx;
  await ctx.pendingPromises.awaitAll();
  return ctx.checkpoints.create(ctx);
}

export function getCheckpoint(
  checkpointId: number,
  __state?: InternalFunctionState,
): Checkpoint {
  const ctx = __state!.ctx;
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
  __state?: InternalFunctionState,
): never {
  const ctx = __state!.ctx;
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
  ctx.checkpoints.trackRestore(cp.id);
  ctx.checkpoints.invalidateAfter(cp.id);
  ctx.pendingPromises.clear();
  throw new RestoreSignal(cp, options);
}
