import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { argsProblem, planJobs, uploadExclusions, type CliArgs, type Job } from "./jobs.js";
import { containerEnv, readOptions, type WrapperOptions } from "./options.js";
import { runPool } from "./pool.js";
import type { JobResult, RunJobArgs } from "./runJob.js";
import { summaryLines, type ListedRun, type SummaryRow } from "./summary.js";

/** What `main` gives the job runner; the command adds how to make a
 *  container. */
export type JobArgs = Pick<
  RunJobArgs,
  "options" | "projectDir" | "exclude" | "env" | "agencyTarball" | "keep" | "signal" | "log"
>;

/** Everything `main` needs from outside, so tests can stand in for the
 *  project's agency, for Daytona and for the terminal. */
export type MainDeps = {
  /** The directory the command was started in. It is what gets copied into
   *  each container. */
  projectDir: string;
  env: Record<string, string | undefined>;
  /** The tests `agency eval run` would select: `agency eval ls --json`. */
  listTests(cli: CliArgs): Promise<{ id: string; timeoutSec?: number }[]>;
  /** A run directory's results: `agency runs list --json`. */
  listRuns(runDir: string): ListedRun[];
  /** What the wrapper reads from the project's agency.json. */
  agencyConfig(): { runsDir: string; maxBatchCostUsd?: number };
  /** The agency tarball to install in each container. */
  agencyTarball(options: WrapperOptions): string;
  runJob(job: Job, args: JobArgs): Promise<JobResult>;
  /** Aborted on the first Ctrl-C. */
  signal: AbortSignal;
  log(line: string): void;
};

const EXIT_OK = 0;
const EXIT_FAILED = 1;
/** The usual exit code after Ctrl-C, given even when every run in flight
 *  came back: the invocation did not finish what it was asked to do. */
const EXIT_INTERRUPTED = 130;
const BATCH_SUFFIX_LENGTH = 8;
const GROUP_SUFFIX_LENGTH = 6;

/** The default group directory name, in the form `agency eval run` uses:
 *  a local-time stamp, then a short random suffix. */
function defaultGroupName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${day}-${time}-${nanoid(GROUP_SUFFIX_LENGTH)}`;
}

/** Runs the selected tests, one container per test and trial, and prints
 *  what happened. Returns the exit code. */
export async function main(cli: CliArgs, deps: MainDeps): Promise<number> {
  const { projectDir, log } = deps;
  const problem = argsProblem(cli, projectDir);
  if (problem !== undefined) {
    log(problem);
    return EXIT_FAILED;
  }
  const options = readOptions(projectDir);
  const config = deps.agencyConfig();
  const groupDir = path.resolve(projectDir, cli.out ?? path.join(config.runsDir, defaultGroupName()));
  if (fs.existsSync(groupDir)) {
    log(`${groupDir} already exists; --out must name a directory that does not exist yet`);
    return EXIT_FAILED;
  }
  const tests = await deps.listTests(cli);
  if (tests.length === 0) {
    log("no test in the suite matches; nothing to run");
    return EXIT_FAILED;
  }
  const env = containerEnv({ names: options.env, pairs: cli.env, hostEnv: deps.env });
  if (env.missing.length > 0) {
    log(`not set, so not passed to the containers: ${env.missing.join(", ")}`);
  }

  // One batch id for the whole invocation, in the form `agency eval run`
  // mints, so the runs of every container show as one batch.
  const batch = `${path.basename(groupDir)}-${nanoid(BATCH_SUFFIX_LENGTH)}`;
  const jobs = planJobs({ cli, tests, projectDir, groupDir, batch, graceSec: options.graceSec });
  const jobArgs: JobArgs = {
    options,
    projectDir,
    exclude: uploadExclusions({ projectDir, groupDir, runsDir: config.runsDir }),
    env: env.values,
    agencyTarball: deps.agencyTarball(options),
    keep: cli.keep,
    signal: deps.signal,
    log,
  };
  fs.mkdirSync(groupDir, { recursive: true });
  log(`run dir: ${groupDir}`);
  log(`${jobs.length} job${jobs.length === 1 ? "" : "s"}, ${cli.parallel} at a time; logs in ${path.join(groupDir, ".logs")}`);

  let spentUsd = 0;
  const overBudget = (): boolean =>
    config.maxBatchCostUsd !== undefined && spentUsd > config.maxBatchCostUsd;
  const finished = await runPool(
    jobs,
    cli.parallel,
    async (job): Promise<Omit<SummaryRow, "label">> => {
      log(`[${job.label}] starting`);
      const result = await deps.runJob(job, jobArgs);
      const run = result.cameBack ? deps.listRuns(job.hostRunDir)[0] : undefined;
      spentUsd += run?.summary.costUsd ?? 0;
      log(`[${job.label}] ${result.cameBack ? "came back" : "brought nothing back"}`);
      return { result, run };
    },
    () => deps.signal.aborted || overBudget(),
  );

  const rows: SummaryRow[] = finished.map(({ item, result }) =>
    result === "not started" ? { label: item.label, result } : { label: item.label, ...result },
  );
  for (const line of summaryLines(rows)) {
    log(line);
  }
  if (overBudget()) {
    log(
      `batch cost cap exceeded: $${spentUsd.toFixed(2)} spent; the remaining jobs were not started (eval.limits.maxBatchCostUsd raises it)`,
    );
  }
  log(`upload with: agency eval upload ${path.relative(projectDir, groupDir) || groupDir}`);

  if (deps.signal.aborted) {
    return EXIT_INTERRUPTED;
  }
  const everyJobCameBack = rows.every((row) => row.result !== "not started" && row.result.cameBack);
  return everyJobCameBack ? EXIT_OK : EXIT_FAILED;
}
