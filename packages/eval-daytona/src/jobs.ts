import * as fs from "fs";
import * as path from "path";

/** The command line of `agency-eval-daytona`: the arguments of `agency eval
 *  run` that make sense for a suite, and two of its own. */
export type CliArgs = {
  /** An agent file. Exactly one of this and `agentCmd`. */
  agent?: string;
  agentCmd?: string;
  suite: string;
  test: string[];
  tags: string[];
  out?: string;
  /** How many containers to run at once. */
  parallel: number;
  trials: number;
  /** `--env NAME=VALUE`, repeatable. */
  env: string[];
  /** Leave each container running afterwards. */
  keep: boolean;
};

/** One test, one trial, one container. */
export type Job = {
  testId: string;
  trial: number;
  /** Names the job in the summary, its log file and its container. */
  label: string;
  /** Where the run directory ends up on this machine. */
  hostRunDir: string;
  logFile: string;
  /** The command to run inside the container, from the project copy. */
  innerArgv: string[];
  /** How long the inner command may run. */
  maxSeconds: number;
};

export const REMOTE_PROJECT = "/eval/project";
export const REMOTE_OUT = "/eval/out";
/** The limit `agency eval run` gives a test that names none, when the
 *  project's agency.json sets no `eval.limits.wallClockSec` either. */
export const DEFAULT_TEST_SECONDS = 60;
/** agency-lang's fixed limit for a test's setup command. */
export const SETUP_SECONDS = 1800;

const INPUT_PLACEHOLDER = "{input}";
const GLOB_CHARACTERS = /[*?[\]{}]/;
const ALWAYS_EXCLUDED = ["node_modules", ".git"];

/** A path as the project copy in the container will know it: relative to
 *  the project directory. Undefined when it is outside the project. */
function insideProject(projectDir: string, given: string): string | undefined {
  const relative = path.relative(projectDir, path.resolve(projectDir, given));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

/** Why these arguments cannot be wrapped, or undefined. Checked before any
 *  container starts. */
export function argsProblem(args: CliArgs, projectDir: string): string | undefined {
  if ((args.agent === undefined) === (args.agentCmd === undefined)) {
    return "give exactly one of an agent file or --agent-cmd";
  }
  if (args.agentCmd !== undefined && !args.agentCmd.includes(INPUT_PLACEHOLDER)) {
    return `--agent-cmd must contain ${INPUT_PLACEHOLDER}, where each test's input goes`;
  }
  const suite = path.resolve(projectDir, args.suite);
  if (!fs.existsSync(suite) || !fs.statSync(suite).isDirectory()) {
    return `--suite must be a directory of tests; ${args.suite} is not one`;
  }
  if (insideProject(projectDir, args.suite) === undefined) {
    return `--suite must be inside the project (${projectDir}), which is what gets copied into each container`;
  }
  if (args.agent !== undefined && insideProject(projectDir, args.agent) === undefined) {
    return `the agent file must be inside the project (${projectDir}), which is what gets copied into each container`;
  }
  if (!Number.isInteger(args.parallel) || args.parallel < 1) {
    return "-n must be a positive whole number";
  }
  if (!Number.isInteger(args.trials) || args.trials < 1) {
    return "--trials must be a positive whole number";
  }
  return undefined;
}

/** Folders left out of the copy of the project, as paths from its top:
 *  dependencies and history, every earlier run, and this invocation's own
 *  output when it is somewhere else inside the project. */
export function uploadExclusions(args: {
  projectDir: string;
  groupDir: string;
  runsDir: string;
}): string[] {
  // However it is spelled ("./runs/"), it is one folder; one outside the
  // project has nothing to leave out.
  const runsDir = insideProject(args.projectDir, args.runsDir);
  const excluded = runsDir === undefined ? [...ALWAYS_EXCLUDED] : [...ALWAYS_EXCLUDED, runsDir];
  const group = insideProject(args.projectDir, args.groupDir);
  const alreadyOut =
    group === undefined || excluded.some((entry) => group === entry || group.startsWith(`${entry}/`));
  return alreadyOut ? excluded : [...excluded, group];
}

/** One job per test and trial, trial-major (`a-1, b-1, a-2, b-2`), so an
 *  interrupted invocation leaves whole trials behind. This is the order and
 *  the layout `agency eval run --trials` uses. */
export function planJobs(args: {
  cli: CliArgs;
  tests: { id: string; timeoutSec?: number }[];
  projectDir: string;
  /** The limit for a test that names none: the project's own. */
  defaultTestSeconds: number;
  groupDir: string;
  batch: string;
  graceSec: number;
}): Job[] {
  for (const test of args.tests) {
    if (GLOB_CHARACTERS.test(test.id)) {
      throw new Error(
        `test id "${test.id}" holds a pattern character (* ? [ ] { }), and the --test that selects it inside the container would read it as a pattern; rename the test`,
      );
    }
  }
  const { cli } = args;
  const agentArgs =
    cli.agent === undefined
      ? ["--agent-cmd", cli.agentCmd ?? ""]
      : [insideProject(args.projectDir, cli.agent) ?? cli.agent];
  const suite = insideProject(args.projectDir, cli.suite) ?? cli.suite;
  const jobs: Job[] = [];
  for (let trial = 1; trial <= cli.trials; trial += 1) {
    for (const test of args.tests) {
      const label = cli.trials > 1 ? `${test.id}-${trial}` : test.id;
      const testDir = path.join(args.groupDir, test.id);
      jobs.push({
        testId: test.id,
        trial,
        label,
        hostRunDir: cli.trials > 1 ? path.join(testDir, String(trial)) : testDir,
        logFile: path.join(args.groupDir, ".logs", `${label}.log`),
        innerArgv: [
          "agency", "eval", "run", ...agentArgs,
          "--suite", suite, "--test", test.id,
          "--batch", args.batch, "--trial-number", String(trial),
          "--grade", "--no-workdir-snapshot", "--out", REMOTE_OUT,
        ],
        maxSeconds: (test.timeoutSec ?? args.defaultTestSeconds) + SETUP_SECONDS + args.graceSec,
      });
    }
  }
  return jobs;
}
