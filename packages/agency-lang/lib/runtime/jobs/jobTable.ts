import type { Host, RunResult, RunningProcess } from "../../host/host.js";
import type { Clock } from "../clock.js";
import { collapseCarriageReturns } from "./progressText.js";

/**
 * The background jobs of one run: shell commands that keep running while
 * the program does other work. The table is plain data and the functions
 * below take it. It lives on the run's context (`RuntimeContext.jobs`)
 * and is never saved in a checkpoint, because a running process is not
 * data. See docs/dev/stdlib/jobs.md.
 */

export const MAX_RUNNING_JOBS = 8;
export const MAX_FINISHED_JOBS = 20;
export const JOB_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;

export type JobState = "running" | "ended" | "stopped" | "timedOut";

export type JobSummary = {
  /** "job-" and six random hex digits, such as "job-3fa9c1". Random, so a
   *  resumed session never reuses an id its conversation already holds. */
  id: string;
  /** The command as the caller wrote it. */
  command: string;
  state: JobState;
  exitCode: number | null;
  /** Milliseconds, from the host's clock. */
  startedAt: number;
  endedAt: number | null;
  /** The job has ended and no read has returned its final state yet. */
  unread: boolean;
};

export type JobReport = JobSummary & {
  /** New since the last read, with carriage returns collapsed. */
  stdout: string;
  stderr: string;
  note: string;
};

export type JobStart = {
  /** The text that runs. */
  command: string;
  /** The text the summary shows as `command`. */
  label: string;
  /** The working directory; the host's own when empty. */
  cwd: string;
  maxMs: number;
};

/** Characters of each stream already returned by `readJob`. */
type ReadPositions = { stdout: number; stderr: number };

type Job = {
  summary: JobSummary;
  /** Null once a read has returned the final state, which frees the output. */
  process: RunningProcess | null;
  /** The job's own signal. Only `endJob` and `closeJobTable` abort it. */
  controller: AbortController;
  clock: Clock;
  read: ReadPositions;
  note: string;
  /** Settles once the job's state is final. Never rejects. */
  ended: Promise<void>;
};

export type JobTable = {
  /** In the order they were started. */
  jobs: Job[];
  /** The signals of starts that passed the limit check and have not
   *  finished starting. They count toward the limit, and closing the table
   *  aborts them. */
  starting: AbortController[];
  /** Set when the run ends. No job starts after that. */
  closed: boolean;
  listeners: ((job: JobSummary) => void)[];
};

export function newJobTable(): JobTable {
  return { jobs: [], starting: [], closed: false, listeners: [] };
}

/** Starts the command. When MAX_RUNNING_JOBS are already running, rejects
 *  with an Error whose message says so and lists them. A start that throws
 *  rejects and adds nothing to the table, and so does a start on a closed
 *  table. `capBytes` is for tests. */
export async function addJob(
  table: JobTable,
  host: Host,
  start: JobStart,
  capBytes: number = JOB_OUTPUT_CAP_BYTES,
): Promise<JobSummary> {
  if (table.closed) {
    throw new Error("This run has ended, so no background job can start in it.");
  }
  if (runningJobs(table).length + table.starting.length >= MAX_RUNNING_JOBS) {
    throw new Error(tooManyJobsMessage(table));
  }
  const controller = new AbortController();
  table.starting.push(controller);
  let process: RunningProcess;
  try {
    process = await host.subprocess.start(
      { kind: "shell", script: start.command },
      {
        cwd: start.cwd === "" ? undefined : start.cwd,
        timeoutMs: start.maxMs,
        signal: controller.signal,
        maxOutputBytes: capBytes,
      },
    );
  } finally {
    table.starting = table.starting.filter((each) => each !== controller);
  }
  const clock = host.clock;
  const summary: JobSummary = {
    id: newJobId(table, host),
    command: start.label,
    state: "running",
    exitCode: null,
    startedAt: clock.now(),
    endedAt: null,
    unread: false,
  };
  const job: Job = {
    summary,
    process,
    controller,
    clock,
    read: { stdout: 0, stderr: 0 },
    note: "",
    ended: Promise.resolve(),
  };
  // Most spawn failures arrive after `start` returned, as a rejected
  // `wait()`. They end the job too, or it would stay "running" for good.
  job.ended = process.wait().then(
    (result) => finishJob(table, job, endingOf(result, capBytes)),
    (error: unknown) =>
      finishJob(table, job, {
        state: "ended",
        exitCode: null,
        note: error instanceof Error ? error.message : String(error),
      }),
  );
  table.jobs.push(job);
  return { ...summary };
}

/** The job's state in words: "running", "exit 0", "stopped", "timed out".
 *  The one place a state becomes text. */
export function describeJobState(job: JobSummary): string {
  switch (job.state) {
    case "running":
      return "running";
    case "ended":
      return job.exitCode === null ? "ended" : `exit ${job.exitCode}`;
    case "stopped":
      return "stopped";
    case "timedOut":
      return "timed out";
  }
}

/** The job's state and its output since the last read, or null for an
 *  unknown id. Moves the read position. Once it returns a finished job's
 *  last output, the job lets go of its output, so a finished job holds no
 *  memory for text that was already read. */
export function readJob(table: JobTable, id: string): JobReport | null {
  const job = findJob(table, id);
  if (job === null) {
    return null;
  }
  const output = job.process?.output() ?? { stdout: "", stderr: "" };
  const stdout = output.stdout.slice(job.read.stdout);
  const stderr = output.stderr.slice(job.read.stderr);
  job.read = { stdout: output.stdout.length, stderr: output.stderr.length };
  if (job.summary.state !== "running") {
    job.summary.unread = false;
    job.process = null;
  }
  return {
    ...job.summary,
    stdout: collapseCarriageReturns(stdout),
    stderr: collapseCarriageReturns(stderr),
    note: job.note,
  };
}

/** Resolves when the job has ended, when `waitMs` has passed, or when
 *  `signal` aborts, whichever is first. Never rejects, and never stops
 *  the job. Resolves at once for an unknown id or a finished job. */
export function waitForJob(
  table: JobTable,
  id: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> {
  const job = findJob(table, id);
  if (job === null || job.summary.state !== "running" || signal.aborted || waitMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = job.clock.setTimer(done, waitMs);
    signal.addEventListener("abort", done, { once: true });
    job.ended.then(done);
    function done() {
      job!.clock.clearTimer(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Stops the job and resolves when it has ended. False for an unknown id.
 *  Does not read the job: the caller reads it if it wants the report. */
export async function endJob(table: JobTable, id: string): Promise<boolean> {
  const job = findJob(table, id);
  if (job === null) {
    return false;
  }
  job.controller.abort();
  await job.ended;
  return true;
}

/** Stops every running job and every start still in progress, and refuses
 *  any later start. The run's `cleanup()` calls it. Does not wait. */
export function closeJobTable(table: JobTable): void {
  table.closed = true;
  for (const controller of table.starting) {
    controller.abort();
  }
  for (const job of runningJobs(table)) {
    job.controller.abort();
  }
}

export function listJobs(table: JobTable): JobSummary[] {
  return table.jobs.map((job) => ({ ...job.summary }));
}

/** Calls `listener` once for each job that ends from now on. Returns a
 *  function that removes the listener. */
export function onJobEnd(table: JobTable, listener: (job: JobSummary) => void): () => void {
  table.listeners.push(listener);
  return () => {
    table.listeners = table.listeners.filter((each) => each !== listener);
  };
}

type Ending = { state: JobState; exitCode: number | null; note: string };

function endingOf(result: RunResult, capBytes: number): Ending {
  if (result.truncated !== null) {
    return {
      state: "ended",
      exitCode: result.exitCode,
      note: `Stopped: ${result.truncated} passed the ${describeBytes(capBytes)} cap.`,
    };
  }
  if (result.timedOut) {
    return { state: "timedOut", exitCode: result.exitCode, note: "" };
  }
  if (result.aborted) {
    return { state: "stopped", exitCode: result.exitCode, note: "" };
  }
  return { state: "ended", exitCode: result.exitCode, note: "" };
}

function finishJob(table: JobTable, job: Job, ending: Ending): void {
  job.summary.state = ending.state;
  job.summary.exitCode = ending.exitCode;
  job.summary.endedAt = job.clock.now();
  job.summary.unread = true;
  job.note = ending.note;
  dropOldFinishedJob(table);
  // A listener that throws must not reject `job.ended`, which nothing
  // handles, and must not keep the other listeners from running.
  for (const listener of table.listeners) {
    try {
      listener({ ...job.summary });
    } catch (error) {
      console.warn(`[jobs] a listener for ${job.summary.id} failed: ${(error as Error).message}`);
    }
  }
}

function newJobId(table: JobTable, host: Host): string {
  for (;;) {
    const digits = Array.from(host.random.bytes(3), (byte) => byte.toString(16).padStart(2, "0"));
    const id = `job-${digits.join("")}`;
    if (findJob(table, id) === null) {
      return id;
    }
  }
}

/** Past MAX_FINISHED_JOBS, drops the oldest finished job whose output was
 *  read, or the oldest finished job when every one is unread. */
function dropOldFinishedJob(table: JobTable): void {
  const finished = table.jobs.filter((job) => job.summary.state !== "running");
  if (finished.length <= MAX_FINISHED_JOBS) {
    return;
  }
  const dropped = finished.find((job) => !job.summary.unread) ?? finished[0];
  table.jobs = table.jobs.filter((job) => job !== dropped);
}

function findJob(table: JobTable, id: string): Job | null {
  return table.jobs.find((job) => job.summary.id === id) ?? null;
}

function runningJobs(table: JobTable): Job[] {
  return table.jobs.filter((job) => job.summary.state === "running");
}

function tooManyJobsMessage(table: JobTable): string {
  const running = runningJobs(table)
    .map((job) => `${job.summary.id} (${job.summary.command})`)
    .join(", ");
  return (
    `${MAX_RUNNING_JOBS} background jobs are already running, which is the limit. ` +
    `Stop one before starting another. Running: ${running}.`
  );
}

function describeBytes(bytes: number): string {
  const mebibyte = 1024 * 1024;
  return bytes % mebibyte === 0 ? `${bytes / mebibyte} MiB` : `${bytes}-byte`;
}
