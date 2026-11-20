// What the REPL in agent.agency reads from outside its run: token counts a
// turn raises, and a job it never started.
import path from "node:path";
import { setReplJobsSource } from "agency-lang/stdlib-lib/cli.js";
import { currentHost } from "../../../dist/lib/runtime/currentHost.js";
import { launchJob } from "../../../dist/lib/runtime/jobs/detachedJobs.js";

let counts = { inputTokens: 0, outputTokens: 0, models: {} };

/** A turn's spend: 120 in and 30 out. */
export function bump() {
  counts = { inputTokens: 120, outputTokens: 30, models: {} };
}

export function tokenCounts() {
  return counts;
}

/** Starts a short job outside the REPL's run and gives it to the REPL. */
export async function watchAJob() {
  const record = await launchJob(currentHost(), {
    command: "sleep 1",
    label: "nap",
    cwd: path.resolve("."),
    maxMs: 60_000,
  });
  const held = {
    handle: { id: record.id, kind: "shell", label: "nap", startedAt: record.startedAt },
    read: { stdout: 0, stderr: 0 },
    finalRead: false,
    token: record.token,
  };
  setReplJobsSource(() => [held]);
}
