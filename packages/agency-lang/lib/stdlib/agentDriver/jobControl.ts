// Reading and stopping a session's background jobs between its legs: the
// list `/jobs` shows, a stop a person asks for, and the jobs of a dropped
// turn. Node-only, like the job processes it reads (detachedJobs.ts). A
// front-end imports it as `agency-lang/stdlib-lib/agentDriver/jobControl.js`.
// See docs/dev/stdlib/jobs.md.
import type { Host } from "../../host/host.js";
import { heldJobStatus, requestStop } from "../../runtime/jobs/detachedJobs.js";
import type { HeldJob } from "../../runtime/jobs/heldJobs.js";
import { heldJobSummary, noSuchJobMessage, type JobSummaryForAgency } from "../jobs.js";

/** One summary for each job, read from its record now, so the state is
 *  current and not the state at the pause. The words are `listJobs`'s. */
export async function sessionJobs(host: Host, jobs: HeldJob[]): Promise<JobSummaryForAgency[]> {
  const summaries: JobSummaryForAgency[] = [];
  for (const job of jobs) {
    summaries.push(await heldJobSummary(host, job));
  }
  return summaries;
}

/** What a stop asked for by a person did. */
export type SessionJobStop =
  | { kind: "stopped"; job: JobSummaryForAgency }
  | { kind: "alreadyEnded"; job: JobSummaryForAgency }
  | { kind: "notHeld"; message: string };

/** Stops one of the session's jobs, as `/jobs stop <id>` asks. A job is a
 *  process outside the run, so this runs no leg: it changes nothing in the
 *  run, and the run's read position is left where it was. */
export async function stopSessionJob(args: {
  host: Host;
  jobs: HeldJob[];
  id: string;
}): Promise<SessionJobStop> {
  const { host, jobs, id } = args;
  const held = jobs.find((job) => job.handle.id === id);
  if (held === undefined) {
    const ids = jobs.map((job) => job.handle.id);
    return { kind: "notHeld", message: noSuchJobMessage(id, ids) };
  }
  const before = await heldJobSummary(host, held);
  if (before.state !== "running") {
    return { kind: "alreadyEnded", job: before };
  }
  await requestStop(host, id);
  return { kind: "stopped", job: await heldJobSummary(host, held) };
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
