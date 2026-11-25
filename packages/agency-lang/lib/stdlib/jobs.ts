// The TypeScript side of `std::jobs` and of `startShellJob` in
// std::safeBash. Each job is a process of its own with a folder under the
// Agency home (lib/runtime/jobs/detachedJobs.ts), and the run holds a list
// of the jobs it started on its context (`heldJobs`), saved in every
// checkpoint. See docs/dev/stdlib/jobs.md.
import type { Host } from "../host/host.js";
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { readCause } from "../runtime/errors.js";
import { clockSleep } from "../runtime/jobs/clockSleep.js";
import {
  heldJobStatus,
  jobOutputSince,
  launchJob,
  requestStop,
} from "../runtime/jobs/detachedJobs.js";
import { copyHeldJob, type HeldJob, type JobHandle } from "../runtime/jobs/heldJobs.js";
import {
  MAX_RUNNING_JOBS,
  describeJobState,
  type JobRecord,
  type JobSummary,
} from "../runtime/jobs/jobRecord.js";
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

/** True when a guard's time trip cut the wait short and the runner will
 *  raise that trip as `std::guard` at its next step. */
function isRaisableGuardTrip(run: Run, signal: AbortSignal): boolean {
  return readCause(signal)?.kind === "guardTrip" && run.stack.firstRaisableTrip() !== null;
}

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
  const held: HeldJob = {
    handle,
    read: { stdout: 0, stderr: 0 },
    finalRead: false,
    token: record.token,
  };
  ctx.heldJobs.push(held);
  tellJobStarted(ctx.onJobStarted, held);
  return handle;
}

/** Tells the caller that ran this leg of a job it started
 *  (`InvocationOptions.onJobStarted`). The job is running by now, so a
 *  listener that throws must not fail the start. */
function tellJobStarted(listener: ((job: HeldJob) => void) | undefined, held: HeldJob): void {
  if (listener === undefined) {
    return;
  }
  try {
    listener(copyHeldJob(held));
  } catch (error) {
    console.warn(`[jobs] onJobStarted failed for ${held.handle.id}: ${(error as Error).message}`);
  }
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
  const record = await statusOf(run, held);
  const output =
    record === null
      ? { stdout: "", stderr: "", positions: held.read }
      : await jobOutputSince(host, id, held.read);
  held.read = output.positions;
  const summary = summaryOf(host, held, record);
  // A job with no record here may be running on the machine that started
  // it, so it is not marked as read: handed back there, its real ending
  // still shows as unread.
  if (record !== null && summary.state !== "running") {
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
  if ((await statusOf(run, heldOrThrow(run, id))) !== null) {
    await requestStop(run.ctx.host, id);
  }
  return readHeldJob(run, id);
}

/** Waits up to `waitSeconds` for a held job to end, and reads nothing.
 *  Throws for an id the run does not hold. */
export async function _waitForJobEnd(id: string, waitSeconds: number): Promise<void> {
  const run = currentRun();
  const held = heldOrThrow(run, id);
  const host = run.ctx.host;
  const seconds = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS);
  const signal = run.ctx.getAbortSignal(run.stack);
  const deadline = host.clock.now() + seconds * 1000;
  // The signal can outlive many waits, so the listener goes when the wait
  // does.
  let onAbort = (): void => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted && host.clock.now() < deadline) {
      const record = await statusOf(run, held);
      if (record === null || record.state !== "running") {
        break;
      }
      const pause = clockSleep(host.clock, Math.min(WAIT_POLL_MS, deadline - host.clock.now()));
      await Promise.race([pause.done, aborted]);
      pause.cancel();
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  // A guard trip returns, and the next step raises it as std::guard, so
  // every handler sees it. Any other cancel keeps its cause, which tells
  // an Escape from a kill.
  if (signal.aborted && !isRaisableGuardTrip(run, signal)) {
    throw leafCancel("job wait cancelled", signal);
  }
}

/** The note for a held job with no record on this machine. A session
 *  moved to another machine brings its held jobs and not their folders. */
const MISSING_RECORD_NOTE =
  "This job's record is not on this machine. It may still be running where it was started, or its folder was removed with `agency jobs clean`.";

function heldOrThrow(run: Run, id: string): HeldJob {
  const held = run.ctx.heldJobs.find((each) => each.handle.id === id);
  if (held === undefined) {
    throw new Error(noSuchHeldJobMessage(id, run));
  }
  return held;
}

function noSuchHeldJobMessage(id: string, run: Run): string {
  return noSuchJobMessage(
    id,
    run.ctx.heldJobs.map((held) => held.handle.id),
  );
}

/** What a stop or a read says for an id the session does not hold.
 *  `heldIds` are the ids it does. */
export function noSuchJobMessage(id: string, heldIds: string[]): string {
  const known =
    heldIds.length === 0 ? "This session has no jobs." : `Its jobs are ${heldIds.join(", ")}.`;
  return `There is no job ${id} in this session. ${known}`;
}

function heldSummary(run: Run, held: HeldJob): Promise<JobSummaryForAgency> {
  return heldJobSummary(run.ctx.host, held);
}

/** A held job's summary, read from its record now, as `listJobs` shows it.
 *  Exported so a front-end that holds a session's jobs between its legs
 *  (agentDriver/jobControl.ts) shows them in the same words. */
export async function heldJobSummary(host: Host, held: HeldJob): Promise<JobSummaryForAgency> {
  const record = await heldJobStatus(host, { id: held.handle.id, token: held.token });
  return forAgency(summaryOf(host, held, record), host.clock.wallTime());
}

/** The record of a job the run holds, or null when it is gone or its
 *  token is not the run's, as for an id added to an edited checkpoint. */
function statusOf(run: Run, held: HeldJob): Promise<JobRecord | null> {
  return heldJobStatus(run.ctx.host, { id: held.handle.id, token: held.token });
}

/** A held job as a summary. A job whose record is gone reads as ended. */
function summaryOf(host: Host, held: HeldJob, record: JobRecord | null): JobSummary {
  const state = record?.state ?? "ended";
  return {
    id: held.handle.id,
    command: record?.label ?? held.handle.label,
    state,
    exitCode: record?.exitCode ?? null,
    startedAt: record?.startedAt ?? held.handle.startedAt,
    endedAt: record?.endedAt ?? (record === null ? host.clock.wallTime() : null),
    unread: state !== "running" && !held.finalRead,
  };
}

/** The held jobs that are still running, by their records. */
async function runningHeldJobs(run: Run): Promise<JobRecord[]> {
  const running: JobRecord[] = [];
  for (const held of run.ctx.heldJobs) {
    const record = await statusOf(run, held);
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
