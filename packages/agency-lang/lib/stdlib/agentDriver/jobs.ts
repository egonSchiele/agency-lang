// The background jobs of a session run, as a front-end sees them between
// legs. A job is a process outside the run (lib/runtime/jobs/), and the run
// holds the jobs it started in every checkpoint it takes. See
// docs/dev/agents/session-driver.md and docs/dev/stdlib/jobs.md.
import { z } from "zod";
import type { Host } from "../../host/host.js";
import type { Interrupt } from "../../runtime/interrupts.js";
import { heldJobStatus, requestStop } from "../../runtime/jobs/detachedJobs.js";
import { heldJobSchema, mergeHeldJobs, type HeldJob } from "../../runtime/jobs/heldJobs.js";

const heldJobsSchema = z.array(heldJobSchema);

/** The jobs one interrupt's checkpoint holds. A loaded session's
 *  checkpoint is plain JSON, so it is checked first; one that is not a
 *  list of held jobs holds none. */
function heldJobsIn(interrupt: Interrupt): HeldJob[] {
  const checkpoint: unknown = interrupt.checkpoint;
  if (typeof checkpoint !== "object" || checkpoint === null || !("heldJobs" in checkpoint)) {
    return [];
  }
  const parsed = heldJobsSchema.safeParse(checkpoint.heldJobs);
  return parsed.success ? parsed.data : [];
}

/** Every job the interrupts' checkpoints hold. All of them are read, not
 *  only the first: two parallel tool calls can pause at different times,
 *  and an earlier checkpoint can lack a job the other call started. */
export function heldJobsOf(interrupts: Interrupt[]): HeldJob[] {
  return interrupts.reduce<HeldJob[]>(
    (jobs, interrupt) => mergeHeldJobs(jobs, heldJobsIn(interrupt)),
    [],
  );
}

/** The jobs `later` holds that `earlier` does not: the ones started
 *  between two pauses. */
export function jobsStartedBetween(earlier: Interrupt[], later: Interrupt[]): HeldJob[] {
  const before = heldJobsOf(earlier).map((job) => job.handle.id);
  return heldJobsOf(later).filter((job) => !before.includes(job.handle.id));
}

/** Stops the jobs a dropped turn started (`turnJobsDropped`). The session
 *  went back to a pause that does not hold them, so nothing else could. A
 *  job whose record is gone or has another token is left alone, as is one
 *  that has already ended. */
export async function stopDroppedJobs(host: Host, jobs: HeldJob[]): Promise<void> {
  for (const job of jobs) {
    const record = await heldJobStatus(host, { id: job.handle.id, token: job.token });
    if (record !== null && record.state === "running") {
      await requestStop(host, job.handle.id);
    }
  }
}
