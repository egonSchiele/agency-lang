import { CheckpointError, RestoreSignal } from "./errors.js";
import type { RestoreOptions } from "./errors.js";
import type { InternalFunctionState } from "./types.js";

export async function checkpoint(
  __state: InternalFunctionState,
): Promise<number> {
  const ctx = __state.ctx;
  await ctx.pendingPromises.awaitAll();
  return ctx.checkpoints.create(ctx);
}

export function restore(
  checkpointId: number,
  options: RestoreOptions,
  __state?: InternalFunctionState,
): never {
  const ctx = __state!.ctx;
  const cp = ctx.checkpoints.get(checkpointId);
  if (!cp)
    throw new CheckpointError(
      `Checkpoint ${checkpointId} does not exist or has been deleted`,
    );
  ctx.checkpoints.trackRestore(checkpointId);
  ctx.checkpoints.invalidateAfter(checkpointId);
  ctx.pendingPromises.clear();
  throw new RestoreSignal(cp, options);
}
