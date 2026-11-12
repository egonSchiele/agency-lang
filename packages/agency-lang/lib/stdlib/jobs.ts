// The TypeScript side of `std::jobs` and of `startJob` in std::safeBash.
// The table itself is lib/runtime/jobs/jobTable.ts, on the run's context.
// See docs/dev/stdlib/jobs.md.
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { readCause } from "../runtime/errors.js";
import {
  addJob,
  describeJobState,
  endJob,
  listJobs,
  readJob,
  waitForJob,
  type JobSummary,
} from "../runtime/jobs/jobTable.js";
import { formatElapsed } from "../utils/formatElapsed.js";
import { leafCancel } from "./abortable.js";
import { resolveSpawnCwd } from "./shell.js";

/** The longest one `jobOutput` call waits, so a model that waits still
 *  looks at the output every ten minutes. */
export const MAX_WAIT_SECONDS = 600;

/** A job as Agency code sees it: the state in words and the running time,
 *  in place of the two timestamps. */
export type JobSummaryForAgency = Omit<JobSummary, "startedAt" | "endedAt"> & {
  status: string;
  runningFor: string;
};

export type JobReportForAgency = JobSummaryForAgency & {
  stdout: string;
  stderr: string;
  note: string;
};

function forAgency<J extends JobSummary>(
  job: J,
  now: number,
): Omit<J, "startedAt" | "endedAt"> & { status: string; runningFor: string } {
  const { startedAt, endedAt, ...rest } = job;
  return {
    ...rest,
    status: describeJobState(job),
    runningFor: formatElapsed((endedAt ?? now) - startedAt),
  };
}

function notRunningMessage(id: string): string {
  return (
    `${id} is not running in this run. It was stopped when the run paused or ` +
    `restarted. Start it again if you still need it.`
  );
}

/** True when a guard's time trip cut the wait short and the runner will
 *  raise that trip as `std::guard` at its next step. */
function isRaisableGuardTrip(run: Run, signal: AbortSignal): boolean {
  return readCause(signal)?.kind === "guardTrip" && run.stack.firstRaisableTrip() !== null;
}

/** Starts an approved command as a job and returns its id. Raises
 *  nothing: its only caller, `startJob` in std::safeBash, raised every
 *  effect of the command's plan first. */
export async function _startJob(
  command: string,
  label: string,
  cwd: string,
  maxMs: number,
): Promise<string> {
  const run = currentRun();
  const dir = await resolveSpawnCwd(run.ctx.host, cwd, []);
  const job = await addJob(run.ctx.jobs, run.ctx.host, { command, label, cwd: dir, maxMs });
  return job.id;
}

/** Waits up to `waitSeconds`, then reports. Throws for an unknown id. */
export async function _jobOutput(id: string, waitSeconds: number): Promise<JobReportForAgency> {
  const run = currentRun();
  const table = run.ctx.jobs;
  if (!listJobs(table).some((job) => job.id === id)) {
    throw new Error(notRunningMessage(id));
  }
  const seconds = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS);
  const signal = run.ctx.getAbortSignal(run.stack);
  await waitForJob(table, id, seconds * 1000, signal);
  // A guard trip returns the report as it stands, and the next step
  // raises the trip, so every handler sees it. Any other cancel keeps
  // its cause, which tells an Escape from a kill.
  if (signal.aborted && !isRaisableGuardTrip(run, signal)) {
    throw leafCancel("job wait cancelled", signal);
  }
  const report = readJob(table, id);
  if (report === null) {
    throw new Error(notRunningMessage(id));
  }
  return forAgency(report, run.ctx.clock.now());
}

/** Stops the job, waits for it to end, and returns its last report.
 *  Throws for an unknown id. */
export async function _stopJob(id: string): Promise<JobReportForAgency> {
  const run = currentRun();
  const table = run.ctx.jobs;
  if (!(await endJob(table, id))) {
    throw new Error(notRunningMessage(id));
  }
  // The read clears `unread`, so a job that was stopped on purpose drops
  // off the agent's jobs message.
  const report = readJob(table, id);
  if (report === null) {
    throw new Error(notRunningMessage(id));
  }
  return forAgency(report, run.ctx.clock.now());
}

export function _listJobs(): JobSummaryForAgency[] {
  const run = currentRun();
  const now = run.ctx.clock.now();
  return listJobs(run.ctx.jobs).map((job) => forAgency(job, now));
}
