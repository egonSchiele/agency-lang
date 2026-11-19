// What a job's runner does. The runner is a process of its own, started
// detached by `launchJob` (`node runnerMain.js <dir>`), so the job outlives
// the program that started it. The runner is the command's parent, which
// is the only process that can learn how the command ended. It copies the
// command's output into the job's folder, stops the command when a `stop`
// file appears, and writes the ending into the record. See
// docs/dev/stdlib/jobs.md.
import type { AppendableFile, Host, Root, RunResult, RunningProcess } from "../../host/host.js";
import { clockSleep } from "./clockSleep.js";
import {
  JOB_OUTPUT_CAP_BYTES,
  STDERR_FILE,
  STDOUT_FILE,
  STOP_FILE,
  changeRecord,
  claimJob,
  endingOf,
  readRecord,
  type Ending,
  type JobRecord,
} from "./jobRecord.js";

/** How often the runner copies output and looks for a stop file. */
export const RUNNER_POLL_MS = 250;
/** Only this user reads a job's output. */
const OUTPUT_FILE_MODE = 0o600;

/** Runs the job in `dir` and resolves once its ending is written. Runs
 *  nothing, and resolves at once, when the folder has no record, the
 *  record no longer says `running`, a `stop` file is there, or another
 *  process holds the claim: a starter that gave up waiting for a slow
 *  runner takes the claim before it reports the start failed. */
export async function runJob(
  host: Host,
  dir: string,
  pollMs: number = RUNNER_POLL_MS,
): Promise<void> {
  const root = await host.files.root(dir);
  const first = await readRecord(host, dir);
  if (first === null || first.state !== "running" || (await stopRequested(host, root))) {
    return;
  }
  if (!(await claimJob(host, dir, "runner"))) {
    return;
  }
  const job = await claim(host, dir);
  if (job === null) {
    return;
  }
  // The output files are opened before the command starts, so a failure
  // here ends the job with a note and runs nothing.
  let outputs: Outputs;
  try {
    outputs = await openOutputs(host, root);
  } catch (error) {
    await writeEnding(host, dir, failedEnding(error));
    return;
  }
  try {
    const controller = new AbortController();
    let running: RunningProcess;
    try {
      running = await host.subprocess.start(
        { kind: "shell", script: job.command },
        {
          cwd: job.cwd,
          timeoutMs: job.maxMs,
          signal: controller.signal,
          maxOutputBytes: JOB_OUTPUT_CAP_BYTES,
        },
      );
    } catch (error) {
      await writeEnding(host, dir, failedEnding(error));
      return;
    }
    const commandPid = running.pid;
    if (commandPid !== null) {
      // Read before the update, so the record is read and written with
      // no `ps` call between.
      const commandStartedAt = host.subprocess.processStartedAt(commandPid);
      await changeRecord(host, dir, (current) =>
        current.state === "running" ? { ...current, commandPid, commandStartedAt } : null,
      );
    }
    const ending = await watch(host, root, running, outputs, controller, pollMs);
    await writeEnding(host, dir, ending);
  } finally {
    await outputs.close();
  }
}

/** Writes this process's pid into the record, unless the record no
 *  longer says `running` or another runner got there first. Returns the
 *  record when this runner holds the job, and null when it does not. */
async function claim(host: Host, dir: string): Promise<JobRecord | null> {
  const self = host.system.processId();
  // Read before the update, so the record is read and written with no
  // `ps` call between.
  const runnerStartedAt = host.subprocess.processStartedAt(self);
  const after = await changeRecord(host, dir, (current) =>
    current.state === "running" && current.runnerPid === null
      ? { ...current, runnerPid: self, runnerStartedAt }
      : null,
  );
  return after !== null && after.runnerPid === self && after.state === "running" ? after : null;
}

/** Copies output and looks for a stop file every `pollMs` until the
 *  command ends, then copies the last output and says how it ended. */
async function watch(
  host: Host,
  root: Root,
  running: RunningProcess,
  outputs: Outputs,
  controller: AbortController,
  pollMs: number,
): Promise<Ending> {
  const outcome: Promise<Ending> = running
    .wait()
    .then((result: RunResult) => endingOf(result, JOB_OUTPUT_CAP_BYTES), failedEnding);
  for (;;) {
    const pause = clockSleep(host.clock, pollMs);
    const ended = await Promise.race([outcome, pause.done.then(() => null)]);
    pause.cancel();
    await outputs.copy(running.output());
    if (ended !== null) {
      return ended;
    }
    if (!controller.signal.aborted && (await stopRequested(host, root))) {
      controller.abort();
    }
  }
}

async function writeEnding(host: Host, dir: string, ending: Ending): Promise<void> {
  // A reader may have ended the record already, deciding this runner had
  // died. Its record stands.
  await changeRecord(host, dir, (current) =>
    current.state === "running" ? { ...current, ...ending, endedAt: host.clock.wallTime() } : null,
  );
}

function failedEnding(error: unknown): Ending {
  return {
    state: "ended",
    exitCode: null,
    note: error instanceof Error ? error.message : String(error),
  };
}

async function stopRequested(host: Host, root: Root): Promise<boolean> {
  return (await host.files.stat(root, STOP_FILE)) !== null;
}

type Outputs = {
  /** Appends what each stream has gained since the last copy. */
  copy(output: { stdout: string; stderr: string }): Promise<void>;
  close(): Promise<void>;
};

async function openOutputs(host: Host, root: Root): Promise<Outputs> {
  const options = { fileMode: OUTPUT_FILE_MODE };
  const files: Record<"stdout" | "stderr", AppendableFile> = {
    stdout: await host.files.openForAppend(root, STDOUT_FILE, options),
    stderr: await host.files.openForAppend(root, STDERR_FILE, options),
  };
  const copied = { stdout: 0, stderr: 0 };
  const encoder = new TextEncoder();
  return {
    copy: async (output) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const added = output[stream].slice(copied[stream]);
        if (added !== "") {
          await files[stream].append(encoder.encode(added));
          copied[stream] = output[stream].length;
        }
      }
    },
    close: async () => {
      await files.stdout.close();
      await files.stderr.close();
    },
  };
}
