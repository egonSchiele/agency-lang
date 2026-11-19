// A background job's record on disk: what it runs, how far it got, and how
// it ended. Each job has a folder, `<agency home>/jobs/<id>/`, which holds
// the record, the two output files, and a `stop` file when someone asked
// the job to stop. No process code is here; the runner (jobRunner.ts) and
// the readers (detachedJobs.ts) both build on it. See
// docs/dev/stdlib/jobs.md.
import path from "#path";
import { z } from "zod";

import type { Host, Root, RunResult } from "../../host/host.js";
import { agencyHomeDir } from "../agencyHome.js";

export const RECORD_FILE = "record.json";
export const STDOUT_FILE = "stdout.log";
export const STDERR_FILE = "stderr.log";
export const STOP_FILE = "stop";
/** What the runner process itself printed, such as a crash at start. */
export const RUNNER_LOG_FILE = "runner.log";
/** Made once, by whichever of the runner or a starter that gave up
 *  waiting gets there first. See `claimJob`. */
export const CLAIM_FILE = "claim";
/** The folder under the Agency home that holds every job's folder. */
export const JOBS_DIR = "jobs";
export const JOB_ID = /^job-[0-9a-f]{6}$/;
/** Each output stream of a job is kept up to this many bytes. Past it the
 *  job is stopped, and its note names the stream. */
export const JOB_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
/** How many of the jobs a run holds may be running or starting at once. */
export const MAX_RUNNING_JOBS = 8;
/** The smallest pid a record may name. 0 and 1 reach far more than one
 *  job when used as a process group. */
const MIN_PID = 2;

export type JobState = "running" | "ended" | "stopped" | "timedOut";

export type JobStart = {
  /** The text that runs. */
  command: string;
  /** The text the summary shows as `command`. */
  label: string;
  /** The working directory. */
  cwd: string;
  maxMs: number;
};

/** Characters of each stream a reader has already been given. */
export type ReadPositions = { stdout: number; stderr: number };

/** A job as a run that holds it sees it. */
export type JobSummary = {
  /** "job-" and six random hex digits, such as "job-3fa9c1". */
  id: string;
  /** The job's label, which is the command unless the start named one. */
  command: string;
  state: JobState;
  exitCode: number | null;
  /** Milliseconds since the Unix epoch. */
  startedAt: number;
  endedAt: number | null;
  /** The job has ended and no read has returned its final state yet. */
  unread: boolean;
};

const pid = z.number().int().min(MIN_PID);

// Strict, as AttachRecordSchema is in lib/debugger/attach/registry.ts: the
// record is read back from disk, and a key nobody wrote means it was not
// written by Agency.
export const JobRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(JOB_ID),
    kind: z.literal("shell"),
    /** The text the summary shows. */
    label: z.string(),
    /** The text that runs. */
    command: z.string(),
    /** Always absolute. */
    cwd: z.string(),
    maxMs: z.number().int().positive(),
    state: z.enum(["running", "ended", "stopped", "timedOut"]),
    exitCode: z.number().int().nullable(),
    note: z.string(),
    /** Milliseconds since the Unix epoch, as are the other times here. */
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    /** Null until the runner has started. */
    runnerPid: pid.nullable(),
    /** As `ps` reports it; null when it could not be read. */
    runnerStartedAt: z.number().nullable(),
    /** The command's pid, which is its process group. Null until it starts. */
    commandPid: pid.nullable(),
    commandStartedAt: z.number().nullable(),
    /** Random, made at the start, and kept by the run that started the job
     *  beside its id. A run acts on a job only when the two match, so an id
     *  added to an edited checkpoint reaches no one else's job. */
    token: z.string(),
  })
  .strict();

export type JobRecord = z.infer<typeof JobRecordSchema>;

export function isJobId(text: string): boolean {
  return JOB_ID.test(text);
}

/** `<agency home>/jobs`. */
export function jobsDir(host: Pick<Host, "settings" | "system">): string {
  return path.join(agencyHomeDir(host), JOBS_DIR);
}

/** The job's folder. Throws for text that is not a job id, so no caller
 *  can build a path from text that came from a command line or a
 *  checkpoint. */
export function jobDir(host: Pick<Host, "settings" | "system">, id: string): string {
  if (!isJobId(id)) {
    throw new Error(`"${id}" is not a job id. A job id is "job-" and six hex digits.`);
  }
  return path.join(jobsDir(host), id);
}

/** How many times a read of a record that exists is tried. The node host
 *  checks, after it opens a file, that the path still names the file it
 *  opened, and refuses the read when it does not. The runner replaces the
 *  record whole each time it writes, so a read in another process can land
 *  on that moment. The next try reads the new record. */
const RECORD_READ_ATTEMPTS = 3;

/** The record in `dir`, or null when there is none or it is not one this
 *  code wrote. Throws when a record is there and cannot be read, so a
 *  failed read is never taken for a job that does not exist. */
export async function readRecord(host: Host, dir: string): Promise<JobRecord | null> {
  let root: Root;
  try {
    root = await host.files.root(dir);
  } catch {
    return null;
  }
  for (let attempt = 1; ; attempt++) {
    if ((await host.files.stat(root, RECORD_FILE)) === null) {
      return null;
    }
    try {
      return parseRecord(await host.files.readText(root, RECORD_FILE));
    } catch (error) {
      if (attempt >= RECORD_READ_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/** Writes the record. Throws for one `readRecord` would refuse, so a bad
 *  record fails here, with the reason, and is never written to be read
 *  back as missing. */
export async function writeRecord(host: Host, dir: string, record: JobRecord): Promise<void> {
  JobRecordSchema.parse(record);
  await host.files.writeText(await host.files.root(dir), RECORD_FILE, recordText(record));
}

/** Takes the job's claim for `who`, or learns that another process took it
 *  first. The claim file is created only if it is not there, and the
 *  platform makes that one step, so exactly one of the runner and a
 *  starter that gave up waiting ever holds it. The runner runs the command
 *  only with the claim; the starter reports a failed start only with it.
 *  A read and write of the record cannot decide this, because nothing
 *  stops another process writing between them. */
export async function claimJob(host: Host, dir: string, who: string): Promise<boolean> {
  const root = await host.files.root(dir);
  try {
    await host.files.writeText(root, CLAIM_FILE, who, { mode: "create-only" });
    return true;
  } catch (error) {
    if ((await host.files.stat(root, CLAIM_FILE)) !== null) {
      return false;
    }
    throw error;
  }
}

/** Thrown inside `updateText` to leave the file as it is. */
class NoChange extends Error {}

/** Reads the record, applies `change`, and writes the result, with nothing
 *  in this process able to run in between. Another process can write
 *  between the read and the write, so the protocol keeps one writer at a
 *  time: the starter until the runner holds the claim, then the runner,
 *  and a reader only once the runner is gone. `change` returns null to
 *  leave the record as it is. Returns the record as it now stands, or null
 *  when there is none. */
export async function changeRecord(
  host: Host,
  dir: string,
  change: (current: JobRecord) => JobRecord | null,
): Promise<JobRecord | null> {
  const root = await host.files.root(dir);
  // The read inside the update can land on another process replacing the
  // record, as a plain read can (RECORD_READ_ATTEMPTS).
  for (let attempt = 1; ; attempt++) {
    let after: JobRecord | null = null;
    try {
      await host.files.updateText(root, RECORD_FILE, (text) => {
        const current = text === null ? null : parseRecord(text);
        if (current === null) {
          throw new NoChange();
        }
        after = current;
        const changed = change(current);
        if (changed === null) {
          throw new NoChange();
        }
        after = changed;
        return recordText(changed);
      });
      return after;
    } catch (error) {
      if (error instanceof NoChange) {
        return after;
      }
      if (attempt >= RECORD_READ_ATTEMPTS) {
        throw error;
      }
    }
  }
}

function parseRecord(text: string): JobRecord | null {
  try {
    const parsed = JobRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function recordText(record: JobRecord): string {
  return JSON.stringify(record, null, 2) + "\n";
}

export type Ending = { state: JobState; exitCode: number | null; note: string };

/** The job's state in words: "running", "exit 0", "stopped", "timed out".
 *  The one place a state becomes text. */
export function describeJobState(job: { state: JobState; exitCode: number | null }): string {
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

/** How a command that finished ended, from what the host reported. */
export function endingOf(result: RunResult, capBytes: number): Ending {
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

function describeBytes(bytes: number): string {
  const mebibyte = 1024 * 1024;
  return bytes % mebibyte === 0 ? `${bytes / mebibyte} MiB` : `${bytes}-byte`;
}
