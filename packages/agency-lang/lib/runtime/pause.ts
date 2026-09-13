import type { Checkpoint } from "./state/checkpointStore.js";
import { pausedCheckpointSchema } from "./state/schemas.js";

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
