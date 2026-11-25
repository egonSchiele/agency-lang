import * as fs from "fs";
import * as path from "path";

import { REMOTE_OUT, REMOTE_PROJECT, type Job } from "./jobs.js";
import { runLongCommand, type LongCommandArgs, type LongCommandResult } from "./longCommand.js";
import type { WrapperOptions } from "./options.js";
import { mustExec, quote } from "./shell.js";
import { tarDirectory, untarGz } from "./tar.js";
import type { Sandbox } from "./types.js";
import { withSandbox } from "./withSandbox.js";

/** Every flag the inner command passes. Checked against `agency eval run
 *  --help` in the container, so an agency that is too old fails with a
 *  message that says so, not with "unknown option". */
export const REQUIRED_FLAGS = ["--grade", "--no-workdir-snapshot", "--trial-number", "--batch"];

/** How one job ended. `cameBack` says whether a run directory is now at
 *  `job.hostRunDir`. `problem` is set when something is worth telling the
 *  user; a job can have a problem and still have come back. */
export type JobResult = { cameBack: boolean; problem?: string };

export type RunJobArgs = {
  options: WrapperOptions;
  projectDir: string;
  /** Paths left out of the project copy, from its top. */
  exclude: string[];
  env: Record<string, string>;
  agencyTarball: string;
  keep: boolean;
  /** Aborted on Ctrl-C: the inner run is interrupted and what it wrote is
   *  still brought back. */
  signal: AbortSignal;
  createSandbox(label: string): Promise<Sandbox>;
  log?: (line: string) => void;
  /** For tests: how the wait for the inner command polls. */
  poll?: Pick<LongCommandArgs, "pollSeconds" | "sleep" | "now">;
};

const REMOTE_TARBALL = "/tmp/agency-lang.tgz";
const REMOTE_PROJECT_TAR = "/tmp/project.tar";
const REMOTE_RUN_ARCHIVE = "/tmp/run.tgz";
const INSTALL_TIMEOUT_SEC = 900;
const PACK_TIMEOUT_SEC = 900;
const LOG_TAIL_CHARS = 2000;
const DOWNLOAD_ATTEMPTS = 3;
/** `timeout`'s own exit code: the inner command ran out its limit. */
const EXIT_TIMED_OUT = 124;
/** `agency eval run` exits 2 when it ran and wrote its run directories but a
 *  test ended in error. The run directory says which, so this is not a
 *  problem with the job. */
const EXIT_A_TEST_ERRORED = 2;

/** Runs one job in a container of its own: install agency, copy the
 *  project in, run the inner `agency eval run`, and bring the run directory
 *  back. Never throws: whatever went wrong is the result's `problem`. The
 *  container is deleted on the way out unless `keep` is set. */
export async function runJob(job: Job, args: RunJobArgs): Promise<JobResult> {
  try {
    return await withSandbox(
      () => args.createSandbox(job.label),
      (sandbox) => runInSandbox(sandbox, job, args),
      { keep: args.keep, log: args.log },
    );
  } catch (error) {
    return { cameBack: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

async function runInSandbox(sandbox: Sandbox, job: Job, args: RunJobArgs): Promise<JobResult> {
  await installAgency(sandbox, args.agencyTarball);
  const missing = await missingFlag(sandbox);
  if (missing !== undefined) {
    return {
      cameBack: false,
      problem: `the agency installed in the container is too old for agency-eval-daytona: eval run has no ${missing}`,
    };
  }
  await uploadProject(sandbox, args.projectDir, args.exclude);
  // Setting the container up can take minutes. An interrupt that came during
  // it must not start a test, and its model spend, after the fact.
  if (args.signal.aborted) {
    return { cameBack: false, problem: "interrupted before the test started" };
  }

  fs.mkdirSync(path.dirname(job.logFile), { recursive: true });
  let ended: LongCommandResult | undefined;
  let lostContact = "";
  try {
    ended = await runLongCommand(sandbox, {
      argv: job.innerArgv,
      cwd: REMOTE_PROJECT,
      env: args.env,
      maxSeconds: job.maxSeconds,
      onOutput: (chunk) => fs.appendFileSync(job.logFile, chunk),
      signal: args.signal,
      ...args.poll,
    });
  } catch (error) {
    lostContact = error instanceof Error ? error.message : String(error);
  }

  // Whatever happened to the command, a run directory it finished writing
  // is brought back: a run with grades missing beats a paid run that vanishes.
  const cameBack = await bringBack(sandbox, job);
  if (ended === undefined) {
    const what = cameBack ? "what it had written was brought back" : "nothing came back";
    return {
      cameBack,
      problem: `lost contact with the container while the test ran (${lostContact}); ${what}`,
    };
  }
  return { cameBack, ...problemOf(job, ended, cameBack) };
}

async function installAgency(sandbox: Sandbox, tarballFile: string): Promise<void> {
  await sandbox.upload(fs.readFileSync(tarballFile), REMOTE_TARBALL);
  await mustExec(
    sandbox,
    "installing agency",
    `npm install -g ${REMOTE_TARBALL} > /tmp/agency-install.log 2>&1 || { tail -c 3000 /tmp/agency-install.log; exit 1; }`,
    { timeoutSec: INSTALL_TIMEOUT_SEC },
  );
}

/** The first flag the wrapper needs that this container's agency lacks. */
async function missingFlag(sandbox: Sandbox): Promise<string | undefined> {
  const help = await mustExec(sandbox, "agency eval run --help", "agency eval run --help 2>&1");
  return REQUIRED_FLAGS.find((flag) => !help.includes(flag));
}

/** Copies the project in. Only the copy is root-only: it holds the suite's
 *  grader files, which the agent must not read. `/eval` and `/eval/out`
 *  stay open, because the agent's workdir is under `/eval/out` and an agent
 *  running as another user has to reach it. */
async function uploadProject(sandbox: Sandbox, projectDir: string, exclude: string[]): Promise<void> {
  await sandbox.upload(tarDirectory(projectDir, exclude), REMOTE_PROJECT_TAR);
  await mustExec(
    sandbox,
    "unpacking the project",
    `mkdir -p ${REMOTE_PROJECT} ${REMOTE_OUT} && tar -xf ${REMOTE_PROJECT_TAR} -C ${REMOTE_PROJECT} && ` +
      `rm ${REMOTE_PROJECT_TAR} && chmod 700 ${REMOTE_PROJECT} && chmod 755 /eval ${REMOTE_OUT}`,
  );
}

/** Downloads the job's run directory when the container holds one. Returns
 *  whether it did. */
async function bringBack(sandbox: Sandbox, job: Job): Promise<boolean> {
  const remoteRunDir = `${REMOTE_OUT}/${job.testId}`;
  const exists = (await sandbox.exec(`test -d ${quote(remoteRunDir)}`)).exitCode === 0;
  if (!exists) {
    return false;
  }
  if (fs.existsSync(job.hostRunDir)) {
    throw new Error(
      `${job.hostRunDir} already exists, so this run was not brought back; ` +
        "it is deleted with its container unless --keep is given",
    );
  }
  // A statelog can be hundreds of MB, and compresses to a small download.
  await mustExec(
    sandbox,
    "packing the run directory",
    `tar -czf ${REMOTE_RUN_ARCHIVE} -C ${quote(remoteRunDir)} --exclude=./workdir .`,
    { timeoutSec: PACK_TIMEOUT_SEC },
  );
  const archive = await downloadWithRetry(sandbox, REMOTE_RUN_ARCHIVE);
  fs.mkdirSync(job.hostRunDir, { recursive: true });
  untarGz(archive, job.hostRunDir);
  return true;
}

/** Downloads a file, trying again after a failure: the container is about
 *  to be deleted, and this file is the whole result of the test. */
async function downloadWithRetry(sandbox: Sandbox, remotePath: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sandbox.download(remotePath);
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/** What to tell the user about how the inner command ended, if anything. */
function problemOf(job: Job, ended: LongCommandResult, cameBack: boolean): { problem?: string } {
  if (ended.interrupted) {
    return { problem: "interrupted, not graded" };
  }
  if (!cameBack) {
    return { problem: `no run directory came back (exit ${ended.exitCode}):\n${logTail(job.logFile)}` };
  }
  // Grades are written all at once when a run's grading ends, so a run cut
  // off at the limit has none.
  if (ended.timedOut || ended.exitCode === EXIT_TIMED_OUT) {
    return { problem: `stopped at the wrapper's time limit (${job.maxSeconds}s); not graded` };
  }
  if (ended.exitCode !== 0 && ended.exitCode !== EXIT_A_TEST_ERRORED) {
    return { problem: `the inner eval run exited with code ${ended.exitCode}` };
  }
  return {};
}

function logTail(logFile: string): string {
  if (!fs.existsSync(logFile)) {
    return "(the inner command printed nothing)";
  }
  return fs.readFileSync(logFile, "utf8").trimEnd().slice(-LOG_TAIL_CHARS);
}
