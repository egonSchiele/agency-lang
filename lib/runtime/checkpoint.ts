import type { RuntimeContext } from "./state/context.js";
import { CheckpointError, RestoreSignal } from "./errors.js";
import type { RestoreOptions } from "./errors.js";

export async function checkpoint(ctx: RuntimeContext<any>): Promise<number> {
  await ctx.pendingPromises.awaitAll();
  return ctx.checkpoints.create(ctx);
}

export function restore(
  ctx: RuntimeContext<any>,
  checkpointId: number,
  options?: RestoreOptions,
): never {
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
