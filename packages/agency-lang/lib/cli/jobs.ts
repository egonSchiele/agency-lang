// `agency jobs`: list the background jobs on this machine, stop one, or
// remove the folders of the ones that have ended. A job is a folder under
// `<agency home>/jobs/` (docs/dev/stdlib/jobs.md); this reads and writes
// those folders and runs no Agency code, so it needs no run and no policy.
// Stopping a job here is a person's action at their own terminal.
import { EXIT_CODE_USAGE_ERROR } from "@/constants.js";
import type { Host } from "@/host/host.js";
import { listJobRecords, removeEndedJobs, requestStop } from "@/runtime/jobs/detachedJobs.js";
import { describeJobState, isJobId, type JobRecord } from "@/runtime/jobs/jobRecord.js";
import { formatElapsed } from "@/utils/formatElapsed.js";

export type JobsCommandResult = { text: string; exitCode: number };

/** Prints what an `agency jobs` command returned, a failure on standard
 *  error, and exits with its code. */
export function printJobsResult(result: JobsCommandResult): never {
  if (result.exitCode === 0) {
    console.log(result.text);
  } else {
    console.error(result.text);
  }
  process.exit(result.exitCode);
}

/** One row a job: its id, its state in words, how long it ran or has been
 *  running, and its label. The label is last and never cut. */
export function jobsListing(records: readonly JobRecord[], now: number): string {
  if (records.length === 0) {
    return "No jobs.";
  }
  const rows = records.map((record) => [
    record.id,
    describeJobState(record),
    formatElapsed((record.endedAt ?? now) - record.startedAt),
    record.label,
  ]);
  const header = ["ID", "STATE", "RAN", "LABEL"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]): string =>
    "  " +
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

/** `agency jobs`. A job whose runner has died is ended, and its command
 *  stopped, by this listing as by any reader. */
export async function listJobsCommand(host: Host): Promise<JobsCommandResult> {
  const records = await listJobRecords(host);
  return { text: jobsListing(records, host.clock.wallTime()), exitCode: 0 };
}

/** `agency jobs stop <id>`. Text that is not a job id is never used as a
 *  path. */
export async function stopJobCommand(host: Host, id: string): Promise<JobsCommandResult> {
  const missing = { text: `There is no job ${id}.`, exitCode: EXIT_CODE_USAGE_ERROR };
  if (!isJobId(id)) {
    return missing;
  }
  const record = await requestStop(host, id);
  if (record === null) {
    return missing;
  }
  return { text: `${id}: ${describeJobState(record)}`, exitCode: 0 };
}

/** `agency jobs clean`: removes the folder of every job that is not
 *  running. Nothing else ever removes one. */
export async function cleanJobsCommand(host: Host): Promise<JobsCommandResult> {
  const removed = await removeEndedJobs(host);
  const noun = removed.length === 1 ? "job" : "jobs";
  return { text: `Removed ${removed.length} ended ${noun}.`, exitCode: 0 };
}
