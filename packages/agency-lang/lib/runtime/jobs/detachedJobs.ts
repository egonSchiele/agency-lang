// What a program that starts or reads background jobs calls. A job is a
// folder under `<agency home>/jobs/` and a runner process that owns its
// command (jobRunner.ts). Everything here reads and writes that folder, so
// any program on the machine can list, read, or stop any job. See
// docs/dev/stdlib/jobs.md.
import path from "#path";

import { agencyCliPath } from "../../agencyCliPath.js";
import type { Host, Root } from "../../host/host.js";
import { agencyHomeDir } from "../agencyHome.js";
import { clockSleep } from "./clockSleep.js";
import {
  JOBS_DIR,
  STDERR_FILE,
  STDOUT_FILE,
  STOP_FILE,
  changeRecord,
  claimJob,
  isJobId,
  jobDir,
  jobsDir,
  readRecord,
  writeRecord,
  type JobRecord,
  type JobStart,
  type ReadPositions,
} from "./jobRecord.js";
import { collapseCarriageReturns } from "./progressText.js";

/** How long `launchJob` waits for the runner to write its pid. */
export const START_WAIT_MS = 5000;
/** How long `requestStop` waits for the runner to write the ending. */
export const STOP_WAIT_MS = 5000;
/** How often `launchJob` and `requestStop` read the record while they wait. */
export const RECORD_POLL_MS = 100;
/** How far a live process's start time may be from the one in the record
 *  and still be the same process. `ps` reports whole seconds. */
export const START_TIME_TOLERANCE_MS = 2000;
/** How many ids `launchJob` tries before it gives up. Folders stay until
 *  `agency jobs clean`, so an id may already be taken. */
const ID_ATTEMPTS = 100;
const ID_BYTES = 3;
/** A token too long to guess: 128 bits. */
const TOKEN_BYTES = 16;

export const RUNNER_DIED_STOPPED = "The job's runner died, so its command was stopped.";
const RUNNER_DIED = "The job's runner died.";
const RUNNER_NEVER_STARTED = "The job's runner did not start.";

export type JobOutput = { stdout: string; stderr: string; positions: ReadPositions };

/** Makes a new folder under a new id, writes the first record, starts the
 *  runner, and resolves once the runner has written its pid. When it has
 *  not within START_WAIT_MS, it tries to take the job's claim. With the
 *  claim, it writes a record that reads `ended` and rejects, and a runner
 *  that starts late runs nothing. Without it, the runner took the claim
 *  first and will run the job, so the start succeeded. `start.cwd` must be
 *  absolute. `start.maxMs` is rounded to a whole number. */
export async function launchJob(host: Host, start: JobStart): Promise<JobRecord> {
  if (!path.isAbsolute(start.cwd)) {
    throw new Error(`A job's working folder must be absolute, and "${start.cwd}" is not.`);
  }
  const jobsRoot = await openJobsDir(host);
  const id = await newJobFolder(host, jobsRoot);
  const dir = jobDir(host, id);
  await writeRecord(host, dir, {
    version: 1,
    id,
    kind: "shell",
    label: start.label,
    command: start.command,
    cwd: start.cwd,
    // A limit in minutes times 60000 is often a hair off a whole number
    // (4.1 minutes is 245999.99999999997 ms).
    maxMs: Math.round(start.maxMs),
    state: "running",
    exitCode: null,
    note: "",
    startedAt: host.clock.wallTime(),
    endedAt: null,
    runnerPid: null,
    runnerStartedAt: null,
    commandPid: null,
    commandStartedAt: null,
    token: hexOf(host.random.bytes(TOKEN_BYTES)),
  });
  try {
    await host.subprocess.startDetached({
      kind: "program",
      // The node running this program, as `spawn` starts the CLI.
      program: process.execPath,
      args: [agencyCliPath(), "job-runner", dir],
    });
  } catch (error) {
    await giveUp(host, dir, RUNNER_NEVER_STARTED);
    throw error;
  }
  const deadline = host.clock.now() + START_WAIT_MS;
  for (;;) {
    const current = await readRecord(host, dir);
    if (current !== null && current.runnerPid !== null) {
      return current;
    }
    if (host.clock.now() >= deadline) {
      break;
    }
    await clockSleep(host.clock, RECORD_POLL_MS).done;
  }
  if (await giveUp(host, dir, RUNNER_NEVER_STARTED)) {
    throw new Error(`The job's runner did not start within ${START_WAIT_MS / 1000} seconds.`);
  }
  // The runner took the claim first, so it runs the job.
  const claimed = await readRecord(host, dir);
  if (claimed === null) {
    throw new Error(`The record of job ${id} is gone.`);
  }
  return claimed;
}

/** The record, with a dead runner handled: when a record says `running`
 *  and its runner is gone, the job is ended and its command stopped. Null
 *  when the job has no folder or no readable record. */
export async function jobStatus(host: Host, id: string): Promise<JobRecord | null> {
  const dir = jobDir(host, id);
  await openJobsDir(host);
  const record = await readRecord(host, dir);
  if (record === null || record.state !== "running") {
    return record;
  }
  if (record.runnerPid === null) {
    return neverStarted(host, dir, record);
  }
  if (!runnerGone(host, record)) {
    return record;
  }
  return endForDeadRunner(host, dir, record);
}

/** `jobStatus` for a job a run holds: null when there is no record, or
 *  when the record's token is not the one the run was given at the start.
 *  An id added to an edited checkpoint then reads as no job, and nothing
 *  is done to the job it names: no read, no stop, not even the rule for a
 *  dead runner. */
export async function heldJobStatus(
  host: Host,
  held: { id: string; token: string },
): Promise<JobRecord | null> {
  const dir = jobDir(host, held.id);
  await openJobsDir(host);
  const record = await readRecord(host, dir);
  if (record === null || record.token !== held.token) {
    return null;
  }
  return jobStatus(host, held.id);
}

/** Output after `from` on each stream, carriage returns collapsed, and
 *  the positions to pass next time. Moves nothing on disk, so two readers
 *  of one job never move each other's place. */
export async function jobOutputSince(
  host: Host,
  id: string,
  from: ReadPositions,
): Promise<JobOutput> {
  const dir = jobDir(host, id);
  await openJobsDir(host);
  const root = await host.files.root(dir);
  const stdout = await readIfThere(host, root, STDOUT_FILE);
  const stderr = await readIfThere(host, root, STDERR_FILE);
  return {
    stdout: collapseCarriageReturns(stdout.slice(from.stdout)),
    stderr: collapseCarriageReturns(stderr.slice(from.stderr)),
    positions: { stdout: stdout.length, stderr: stderr.length },
  };
}

/** Writes the stop file and resolves with the record once the job is no
 *  longer running, or after STOP_WAIT_MS. A job that has ended gets no
 *  stop file. Null when the job has no folder. */
export async function requestStop(host: Host, id: string): Promise<JobRecord | null> {
  const first = await jobStatus(host, id);
  if (first === null || first.state !== "running") {
    return first;
  }
  const dir = jobDir(host, id);
  await host.files.writeText(await host.files.root(dir), STOP_FILE, "");
  const deadline = host.clock.now() + STOP_WAIT_MS;
  let current: JobRecord | null = first;
  while (current !== null && current.state === "running" && host.clock.now() < deadline) {
    await clockSleep(host.clock, RECORD_POLL_MS).done;
    current = await jobStatus(host, id);
  }
  return current;
}

/** Every job on this machine, newest first, each read as `jobStatus`
 *  reads it. A folder with no readable record is left out. */
export async function listJobRecords(host: Host): Promise<JobRecord[]> {
  const jobsRoot = await openJobsDir(host);
  const records: JobRecord[] = [];
  for (const entry of await host.files.list(jobsRoot, "")) {
    if (entry.type !== "dir" || !isJobId(entry.name)) {
      continue;
    }
    const record = await jobStatus(host, entry.name);
    if (record !== null) {
      records.push(record);
    }
  }
  return records.sort((a, b) => b.startedAt - a.startedAt);
}

/** Deletes the folder of every job that is not running. Returns their ids. */
export async function removeEndedJobs(host: Host): Promise<string[]> {
  const jobsRoot = await openJobsDir(host);
  const removed: string[] = [];
  for (const record of await listJobRecords(host)) {
    if (record.state !== "running") {
      await host.files.remove(jobsRoot, record.id);
      removed.push(record.id);
    }
  }
  return removed;
}

/** The jobs folder, made or checked as private on every use, as
 *  `ensureSessionsDir` checks its folder: whoever can write a job's folder
 *  can stop the job and forge its record. */
async function openJobsDir(host: Host): Promise<Root> {
  const home = await host.files.root(agencyHomeDir(host));
  await host.files.mkdir(home, "");
  await host.files.privateDir(home, JOBS_DIR);
  return host.files.root(jobsDir(host));
}

/** A new id whose folder this call made. An id is never reused: a new job
 *  in an old job's folder would write into its files and obey its stop. */
async function newJobFolder(host: Host, jobsRoot: Root): Promise<string> {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const id = `job-${hexOf(host.random.bytes(ID_BYTES))}`;
    try {
      await host.files.privateDir(jobsRoot, id, { mustBeNew: true });
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(`Could not find a free job id in ${ID_ATTEMPTS} tries.`);
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Ends a job whose runner has not started it, if this call can take the
 *  claim. A runner that starts later finds the claim taken and runs
 *  nothing. False when the runner took the claim first. */
async function giveUp(host: Host, dir: string, note: string): Promise<boolean> {
  if (!(await claimJob(host, dir, "starter"))) {
    return false;
  }
  await changeRecord(host, dir, (current) =>
    current.state === "running" ? ended(host, current, note) : null,
  );
  return true;
}

/** A record with no runner pid is a launch in progress, until it is older
 *  than two launch waits. Then either the starter died while it waited,
 *  or the runner died after it took the claim and before it wrote its
 *  pid. Either way the command never started, since the runner writes its
 *  pid before it starts the command, so the job is ended. */
async function neverStarted(host: Host, dir: string, record: JobRecord): Promise<JobRecord> {
  if (host.clock.wallTime() - record.startedAt <= 2 * START_WAIT_MS) {
    return record;
  }
  if (!(await giveUp(host, dir, RUNNER_NEVER_STARTED))) {
    await changeRecord(host, dir, (current) =>
      current.state === "running" && current.runnerPid === null
        ? ended(host, current, RUNNER_DIED)
        : null,
    );
  }
  return (await readRecord(host, dir)) ?? record;
}

/** Whether the runner is gone: its pid names no process, or names one
 *  that started at another time, which the system gave the pid to later.
 *  A pid whose state cannot be read is taken as alive. */
function runnerGone(host: Host, record: JobRecord): boolean {
  const pid = record.runnerPid!;
  const state = host.subprocess.processState(pid);
  if (state !== "alive") {
    return state === "gone";
  }
  return !sameProcess(host, pid, record.runnerStartedAt);
}

/** False only when both start times are known and differ. */
function sameProcess(host: Host, pid: number, savedStart: number | null): boolean {
  const liveStart = host.subprocess.processStartedAt(pid);
  if (liveStart === null || savedStart === null) {
    return true;
  }
  return Math.abs(liveStart - savedStart) <= START_TIME_TOLERANCE_MS;
}

/** A job with no runner is stopped. Its command is stopped only when its
 *  start time matches the record, so a pid the system gave to another
 *  process after a reboot is never signalled. */
async function endForDeadRunner(host: Host, dir: string, record: JobRecord): Promise<JobRecord> {
  const note = await stopOrphan(host, record);
  const after = await changeRecord(host, dir, (current) =>
    current.state === "running" ? ended(host, current, note) : null,
  );
  return after ?? record;
}

/** Stops the command a dead runner left behind, when it can be sure it is
 *  the same process, and says what happened. */
async function stopOrphan(host: Host, record: JobRecord): Promise<string> {
  const pid = record.commandPid;
  if (pid === null || host.subprocess.processState(pid) === "gone") {
    return RUNNER_DIED;
  }
  const liveStart = host.subprocess.processStartedAt(pid);
  if (liveStart === null || record.commandStartedAt === null) {
    return `${RUNNER_DIED} Its command may still be running as process ${pid}.`;
  }
  if (Math.abs(liveStart - record.commandStartedAt) > START_TIME_TOLERANCE_MS) {
    return RUNNER_DIED;
  }
  await host.subprocess.stopGroup(pid);
  return RUNNER_DIED_STOPPED;
}

function ended(host: Host, record: JobRecord, note: string): JobRecord {
  return { ...record, state: "ended", exitCode: null, note, endedAt: host.clock.wallTime() };
}

async function readIfThere(host: Host, root: Root, file: string): Promise<string> {
  if ((await host.files.stat(root, file)) === null) {
    return "";
  }
  return host.files.readText(root, file);
}
