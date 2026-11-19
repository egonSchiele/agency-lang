// Tells the terminal when a job it holds has ended, so the REPL can print
// a line. The terminal starts and stops the watch. Nothing in the standard
// library starts one: the host clock's timer keeps a process alive, and a
// program that starts a job and returns must exit. See
// docs/dev/stdlib/jobs.md.
import type { Host } from "../../host/host.js";
import type { TimerHandle } from "../clock.js";
import { jobStatus } from "./detachedJobs.js";
import type { HeldJob } from "./heldJobs.js";
import type { JobRecord } from "./jobRecord.js";

/** How often the watch reads the state of each held job. */
export const WATCH_POLL_MS = 1000;

/** What the watch knows of a job: running when last read, or settled,
 *  which is a job it has reported or will never report. */
type Seen = "running" | "settled";

/** Every WATCH_POLL_MS, reads the state of each job `held()` returns and
 *  calls `ended` once for each job that has ended since the watch began.
 *  A job that had already ended when it was first seen is not reported.
 *  `held` is read on every poll, so a job started in any branch, or one
 *  that came back from a checkpoint, is seen. Returns a function that
 *  stops the watch and clears its timer. */
export function watchHeldJobs(args: {
  host: Host;
  held: () => HeldJob[];
  ended: (job: JobRecord) => void;
}): () => void {
  const { host, held, ended } = args;
  const seen: Record<string, Seen> = {};
  let stopped = false;
  let timer: TimerHandle | null = null;

  const look = async (id: string): Promise<void> => {
    let record: JobRecord | null;
    try {
      record = await jobStatus(host, id);
    } catch {
      record = null;
    }
    if (record === null) {
      seen[id] = "settled";
      return;
    }
    if (record.state === "running") {
      seen[id] = "running";
      return;
    }
    const wasRunning = seen[id] === "running";
    seen[id] = "settled";
    if (!wasRunning || stopped) {
      return;
    }
    // A listener that throws must not stop the watch or the other
    // listeners' lines.
    try {
      ended(record);
    } catch (error) {
      console.warn(`[jobs] the line for ${id} failed: ${(error as Error).message}`);
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    for (const job of held()) {
      if (seen[job.handle.id] !== "settled") {
        await look(job.handle.id);
      }
    }
    if (!stopped) {
      timer = host.clock.setTimer(() => void poll(), WATCH_POLL_MS);
    }
  };

  void poll();
  return () => {
    stopped = true;
    if (timer !== null) {
      host.clock.clearTimer(timer);
      timer = null;
    }
  };
}
