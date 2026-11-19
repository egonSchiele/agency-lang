// A background job's record on disk: what it runs, how far it got, and how
// it ended. Each job has a folder, `<agency home>/jobs/<id>/`, which holds
// the record, the two output files, and a `stop` file when someone asked
// the job to stop. No process code is here; the runner (jobRunner.ts) and
// the readers (detachedJobs.ts) both build on it. See
// docs/dev/stdlib/jobs.md.
import path from "#path";
import { z } from "zod";

import type { Host, RunResult } from "../../host/host.js";
import { agencyHomeDir } from "../agencyHome.js";

export const RECORD_FILE = "record.json";
export const STDOUT_FILE = "stdout.log";
export const STDERR_FILE = "stderr.log";
export const STOP_FILE = "stop";
/** The folder under the Agency home that holds every job's folder. */
export const JOBS_DIR = "jobs";
export const JOB_ID = /^job-[0-9a-f]{6}$/;
/** Each output stream of a job is kept up to this many bytes. Past it the
 *  job is stopped, and its note names the stream. */
export const JOB_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
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

/** The record in `dir`, or null when there is none or it is not one this
 *  code wrote. */
export async function readRecord(host: Host, dir: string): Promise<JobRecord | null> {
  let text: string;
  try {
    text = await host.files.readText(await host.files.root(dir), RECORD_FILE);
  } catch {
    return null;
  }
  return parseRecord(text);
}

export async function writeRecord(host: Host, dir: string, record: JobRecord): Promise<void> {
  await host.files.writeText(await host.files.root(dir), RECORD_FILE, recordText(record));
}

/** Thrown inside `updateText` to leave the file as it is. */
class NoChange extends Error {}

/** Reads the record, applies `change`, and writes the result, with nothing
 *  able to run in between. `change` returns null to leave the record as it
 *  is. Returns the record as it now stands, or null when there is none. */
export async function changeRecord(
  host: Host,
  dir: string,
  change: (current: JobRecord) => JobRecord | null,
): Promise<JobRecord | null> {
  let after: JobRecord | null = null;
  try {
    await host.files.updateText(await host.files.root(dir), RECORD_FILE, (text) => {
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
  } catch (error) {
    if (!(error instanceof NoChange)) {
      throw error;
    }
  }
  return after;
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
