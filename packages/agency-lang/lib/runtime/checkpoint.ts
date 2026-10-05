import { CheckpointError, RestoreSignal } from "./errors.js";
import type { RestoreOptions } from "./errors.js";
import { currentRun, type Run } from "./asyncContext.js";
import { Checkpoint } from "./state/checkpointStore.js";

/**
 * Capture a checkpoint of the current execution state. The source
 * location attached to the checkpoint (`moduleId` / `scopeName` /
 * `stepPath`) is read from the active `agencyStore` frame's
 * `callsite` slot, which `Runner.runInScope` seeds for every step
 * body. Calls made outside a runner step (e.g. from bootstrap scope)
 * fall back to the empty `""::""::""` location.
 */
export async function checkpoint(): Promise<number> {
  return checkpointFor(currentRun());
}

/** `checkpoint()` for a helper that already holds its run, so it can take
 *  a checkpoint after an `await`. */
export async function checkpointFor(run: Run): Promise<number> {
  const { ctx, callsite } = run;
  await ctx.pendingPromises.awaitAll();
  return ctx.checkpoints.create(ctx.stateStack, ctx, {
    moduleId: callsite?.moduleId ?? "",
    scopeName: callsite?.scopeName ?? "",
    stepPath: callsite?.stepPath ?? "",
  });
}

export function getCheckpoint(checkpointId: number): Checkpoint {
  return getCheckpointFor(currentRun(), checkpointId);
}

/** `getCheckpoint()` for a helper that already holds its run. */
export function getCheckpointFor(run: Run, checkpointId: number): Checkpoint {
  const { ctx } = run;
  const cp = ctx.checkpoints.get(checkpointId);
  if (!cp)
    throw new CheckpointError(`Checkpoint ${checkpointId} does not exist or has been deleted`);
  return cp;
}

export function restore(
  checkpointIdOrCheckpoint: number | Checkpoint | Record<string, unknown>,
  options: RestoreOptions,
): void {
  restoreFor(currentRun(), checkpointIdOrCheckpoint, options);
}

/** `restore` for a run the caller already holds. Generated code wraps this
 *  one as an AgencyFunction, whose body is handed the run first. */
export function restoreFor(
  run: Run,
  checkpointIdOrCheckpoint: number | Checkpoint | Record<string, unknown>,
  options: RestoreOptions,
): void {
  const { ctx } = run;
  let cp: Checkpoint;
  if (typeof checkpointIdOrCheckpoint === "number") {
    const found = ctx.checkpoints.get(checkpointIdOrCheckpoint);
    if (!found)
      throw new CheckpointError(
        `Checkpoint ${checkpointIdOrCheckpoint} does not exist or has been deleted`,
      );
    cp = found;
  } else {
    // A checkpoint read back from a file is plain JSON, not an instance.
    const revived = Checkpoint.fromJSON(checkpointIdOrCheckpoint);
    if (!revived) throw new CheckpointError("Invalid checkpoint object passed to restore()");
    cp = revived;
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
