// The TypeScript side of `std::jobs` and of `startJob` in std::safeBash.
// The table itself is lib/runtime/jobs/jobTable.ts, on the run's context.
// See docs/dev/stdlib/jobs.md.
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { readCause } from "../runtime/errors.js";
import {
  MAX_RUNNING_JOBS,
  addJob,
  describeJobState,
  endJob,
  listJobs,
  readJob,
  waitForJob,
  type JobSummary,
} from "../runtime/jobs/jobTable.js";
import { clockSleep } from "../runtime/jobs/clockSleep.js";
import { jobOutputSince, jobStatus, launchJob, requestStop } from "../runtime/jobs/detachedJobs.js";
import type { HeldJob, JobHandle } from "../runtime/jobs/heldJobs.js";
import type { JobRecord } from "../runtime/jobs/jobRecord.js";
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

/** Says only what is known, and lists the ids that do exist, so a typo is
 *  easy to correct. */
function noSuchJobMessage(id: string, run: Run): string {
  const ids = listJobs(run.ctx.jobs).map((job) => job.id);
  const known = ids.length === 0 ? "This run has no jobs." : `Its jobs are ${ids.join(", ")}.`;
  return (
    `There is no job ${id} in this run. ${known} ` +
    `A job started before the run paused or restarted was stopped then.`
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

/** Waits up to `waitSeconds` for the job to end, and reads nothing.
 *  Throws for an unknown id. */
export async function _waitForJob(id: string, waitSeconds: number): Promise<void> {
  const run = currentRun();
  const table = run.ctx.jobs;
  if (!listJobs(table).some((job) => job.id === id)) {
    throw new Error(noSuchJobMessage(id, run));
  }
  const seconds = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS);
  const signal = run.ctx.getAbortSignal(run.stack);
  await waitForJob(table, id, seconds * 1000, signal);
  // A guard trip returns, and the next step raises it as std::guard, so
  // every handler sees it. Any other cancel keeps its cause, which tells
  // an Escape from a kill.
  if (signal.aborted && !isRaisableGuardTrip(run, signal)) {
    throw leafCancel("job wait cancelled", signal);
  }
}

/** The job's state and its output since the last read. Throws for an
 *  unknown id. */
export function _readJob(id: string): JobReportForAgency {
  const run = currentRun();
  const report = readJob(run.ctx.jobs, id);
  if (report === null) {
    throw new Error(noSuchJobMessage(id, run));
  }
  return forAgency(report, run.ctx.clock.now());
}

/** Stops the job, waits for it to end, and returns its last report.
 *  Throws for an unknown id. */
export async function _stopJob(id: string): Promise<JobReportForAgency> {
  const run = currentRun();
  const table = run.ctx.jobs;
  if (!(await endJob(table, id))) {
    throw new Error(noSuchJobMessage(id, run));
  }
  // The read clears `unread`, so a job that was stopped on purpose drops
  // off the agent's jobs message.
  const report = readJob(table, id);
  if (report === null) {
    throw new Error(noSuchJobMessage(id, run));
  }
  return forAgency(report, run.ctx.clock.now());
}

export function _listJobs(): JobSummaryForAgency[] {
  const run = currentRun();
  const now = run.ctx.clock.now();
  return listJobs(run.ctx.jobs).map((job) => forAgency(job, now));
}

// Detached jobs (lib/runtime/jobs/detachedJobs.ts): each is a process of
// its own with a folder under the Agency home, and the run holds a list
// of them on its context (`heldJobs`), saved in every checkpoint.

/** How often a wait reads the job's record. */
const WAIT_POLL_MS = 250;
const RUN_SUBPROCESS_REFUSAL = "startJob cannot be called inside a run() subprocess.";

/** Why a job cannot start in this run, or "" when it can. Checked before
 *  any approval is asked, as `spawn` checks it. */
export function _jobStartRefusal(): string {
  return (currentRun().ctx.subprocessDepth ?? 0) > 0 ? RUN_SUBPROCESS_REFUSAL : "";
}

/** Starts an approved command as a detached job and adds it to the run's
 *  held jobs. Raises nothing: its only caller, `startShellJob` in
 *  std::safeBash, raised every effect of the command's plan first.
 *  Refuses inside a `run()` subprocess, whose code is sandboxed: a job
 *  would outlive the child, and nobody would hold it. Refuses when the
 *  held jobs that are running, plus the starts in progress, are
 *  MAX_RUNNING_JOBS. */
export async function _launchJob(
  command: string,
  label: string,
  cwd: string,
  maxMs: number,
): Promise<JobHandle> {
  const run = currentRun();
  const ctx = run.ctx;
  const host = ctx.host;
  if ((ctx.subprocessDepth ?? 0) > 0) {
    throw new Error(RUN_SUBPROCESS_REFUSAL);
  }
  const dir = await resolveSpawnCwd(host, cwd, []);
  const running = await runningHeldJobs(run);
  // No await between this check and the count going up, so two parallel
  // starts cannot both pass it.
  if (running.length + ctx.startingJobs >= MAX_RUNNING_JOBS) {
    throw new Error(tooManyHeldJobsMessage(running));
  }
  ctx.startingJobs += 1;
  let record: JobRecord;
  try {
    record = await launchJob(host, {
      command,
      label,
      // The runner builds a host of its own, which knows nothing of this
      // host's working folder, so the record always has an absolute one.
      cwd: dir === "" ? host.system.cwd() : dir,
      maxMs,
    });
  } finally {
    ctx.startingJobs -= 1;
  }
  const handle: JobHandle = {
    id: record.id,
    kind: record.kind,
    label: record.label,
    startedAt: record.startedAt,
  };
  ctx.heldJobs.push({ handle, read: { stdout: 0, stderr: 0 }, finalRead: false });
  return handle;
}

/** One summary for each job the run holds, in the order they started. */
export async function _heldSummaries(): Promise<JobSummaryForAgency[]> {
  const run = currentRun();
  const summaries: JobSummaryForAgency[] = [];
  for (const held of run.ctx.heldJobs) {
    summaries.push(await heldSummary(run, held));
  }
  return summaries;
}

/** The summary of one job the run holds. Throws for one it does not. */
export async function _heldSummary(id: string): Promise<JobSummaryForAgency> {
  const run = currentRun();
  return heldSummary(run, heldOrThrow(run, id));
}

/** The job's state and its output since this run's last read. Moves the
 *  run's read position, and nothing on disk. Throws for an id the run
 *  does not hold. */
export async function _readHeldJob(id: string): Promise<JobReportForAgency> {
  return readHeldJob(currentRun(), id);
}

async function readHeldJob(run: Run, id: string): Promise<JobReportForAgency> {
  const held = heldOrThrow(run, id);
  const host = run.ctx.host;
  // The state first: a read that sees the job ended then gets all of the
  // output, since the runner wrote the last of it before the ending.
  const record = await jobStatus(host, id);
  const output = await jobOutputSince(host, id, held.read);
  held.read = output.positions;
  const summary = summaryOf(run, held, record);
  if (summary.state !== "running") {
    held.finalRead = true;
  }
  return {
    ...forAgency({ ...summary, unread: false }, run.ctx.host.clock.wallTime()),
    stdout: output.stdout,
    stderr: output.stderr,
    note: record?.note ?? MISSING_RECORD_NOTE,
  };
}

/** Stops the job, waits for it to end, and returns its last report.
 *  Throws for an id the run does not hold. */
export async function _stopHeldJob(id: string): Promise<JobReportForAgency> {
  const run = currentRun();
  heldOrThrow(run, id);
  await requestStop(run.ctx.host, id);
  return readHeldJob(run, id);
}

/** Waits up to `waitSeconds` for a held job to end, and reads nothing.
 *  Throws for an id the run does not hold. */
export async function _waitForJobEnd(id: string, waitSeconds: number): Promise<void> {
  const run = currentRun();
  heldOrThrow(run, id);
  const host = run.ctx.host;
  const seconds = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS);
  const signal = run.ctx.getAbortSignal(run.stack);
  const deadline = host.clock.now() + seconds * 1000;
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  while (!signal.aborted && host.clock.now() < deadline) {
    const record = await jobStatus(host, id);
    if (record === null || record.state !== "running") {
      break;
    }
    const pause = clockSleep(host.clock, Math.min(WAIT_POLL_MS, deadline - host.clock.now()));
    await Promise.race([pause.done, aborted]);
    pause.cancel();
  }
  // A guard trip returns, and the next step raises it as std::guard, so
  // every handler sees it. Any other cancel keeps its cause, which tells
  // an Escape from a kill.
  if (signal.aborted && !isRaisableGuardTrip(run, signal)) {
    throw leafCancel("job wait cancelled", signal);
  }
}

/** The note for a held job whose folder `agency jobs clean` removed. */
const MISSING_RECORD_NOTE = "The job's record is gone.";

function heldOrThrow(run: Run, id: string): HeldJob {
  const held = run.ctx.heldJobs.find((each) => each.handle.id === id);
  if (held === undefined) {
    throw new Error(noSuchHeldJobMessage(id, run));
  }
  return held;
}

function noSuchHeldJobMessage(id: string, run: Run): string {
  const ids = run.ctx.heldJobs.map((held) => held.handle.id);
  const known = ids.length === 0 ? "This session has no jobs." : `Its jobs are ${ids.join(", ")}.`;
  return `There is no job ${id} in this session. ${known}`;
}

async function heldSummary(run: Run, held: HeldJob): Promise<JobSummaryForAgency> {
  const record = await jobStatus(run.ctx.host, held.handle.id);
  return forAgency(summaryOf(run, held, record), run.ctx.host.clock.wallTime());
}

/** A held job as a summary. A job whose record is gone reads as ended. */
function summaryOf(run: Run, held: HeldJob, record: JobRecord | null): JobSummary {
  const state = record?.state ?? "ended";
  return {
    id: held.handle.id,
    command: record?.label ?? held.handle.label,
    state,
    exitCode: record?.exitCode ?? null,
    startedAt: record?.startedAt ?? held.handle.startedAt,
    endedAt: record?.endedAt ?? (record === null ? run.ctx.host.clock.wallTime() : null),
    unread: state !== "running" && !held.finalRead,
  };
}

/** The held jobs that are still running, by their records. */
async function runningHeldJobs(run: Run): Promise<JobRecord[]> {
  const running: JobRecord[] = [];
  for (const held of run.ctx.heldJobs) {
    const record = await jobStatus(run.ctx.host, held.handle.id);
    if (record !== null && record.state === "running") {
      running.push(record);
    }
  }
  return running;
}

function tooManyHeldJobsMessage(running: JobRecord[]): string {
  const listed = running.map((record) => `${record.id} (${record.label})`).join(", ");
  return (
    `${MAX_RUNNING_JOBS} background jobs are already running, which is the limit. ` +
    `Stop one before starting another. Running: ${listed}.`
  );
}
