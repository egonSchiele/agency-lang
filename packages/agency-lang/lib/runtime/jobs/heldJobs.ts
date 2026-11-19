// The jobs a run holds: the handle of each job the run started, and how
// much of each job's output the run has read. The list is on the run's
// context and saved in every checkpoint, so a pause, a resume in another
// process, or a parallel branch never loses a job. See
// docs/dev/stdlib/jobs.md.
import { z } from "zod";
import { isJobId, type ReadPositions } from "./jobRecord.js";

/** Which job. Plain data, saved with the run. */
export type JobHandle = { id: string; kind: string; label: string; startedAt: number };

export type HeldJob = {
  handle: JobHandle;
  /** What this run has read of each stream. */
  read: ReadPositions;
  /** A read has returned the job's ending. */
  finalRead: boolean;
};

const position = z.number().int().nonnegative();

/** A held job as a checkpoint stores it. The id is not checked here: a
 *  checkpoint with one bad entry still loads, and `mergeHeldJobs` drops
 *  the entry. */
export const heldJobSchema = z.object({
  handle: z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    startedAt: z.number(),
  }),
  read: z.object({ stdout: position, stderr: position }),
  finalRead: z.boolean(),
});

/** The jobs a run holds after it applies a checkpoint: every job it held
 *  already, and every job the checkpoint names that it did not. A job is
 *  real work outside the run, so applying an older checkpoint never
 *  forgets one. An entry whose id is not a job id is dropped, since a
 *  checkpoint is a file a person can edit and an id becomes a path. */
export function mergeHeldJobs(current: HeldJob[], saved: HeldJob[] | undefined): HeldJob[] {
  const merged = [...current];
  for (const job of saved ?? []) {
    const known = merged.some((each) => each.handle.id === job.handle.id);
    if (!known && isJobId(job.handle.id)) {
      merged.push(copyHeldJob(job));
    }
  }
  return merged;
}

/** A copy that shares nothing with `job`, for a checkpoint taken now that
 *  a later read must not change. */
export function copyHeldJob(job: HeldJob): HeldJob {
  return { handle: { ...job.handle }, read: { ...job.read }, finalRead: job.finalRead };
}
