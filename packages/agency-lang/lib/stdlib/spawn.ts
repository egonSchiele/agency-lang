// What `spawn` in std::agency needs from TypeScript: start an Agency
// file as a process of its own, which outlives the caller and shares
// nothing with the caller's run (docs/dev/runtime/spawn.md). The Agency
// side raises `std::spawn` first; nothing here raises an interrupt.
import path from "path";

import { agencyCliPath } from "../agencyCliPath.js";
import { parseTarget } from "../agentTarget.js";
import { LEGAL_IDENTIFIER } from "../parsers/parsers.js";
import { CONFIG_OVERRIDES_ENV, TRACE_ID_ENV } from "../config/config.js";
import {
  AGENCY_SPAWN_DEPTH,
  SEED_FROM_STDIN,
  SPAWN_ERROR_TAIL_CHARS,
  SPAWN_LAUNCH_TIMEOUT_MS,
} from "../constants.js";
import type { Host, Root } from "../host/host.js";
import { agencyHomeDir } from "../runtime/agencyHome.js";
import { currentRun } from "../runtime/asyncContext.js";
import type { Policy } from "../runtime/policy.js";
import { program } from "./abortable.js";

/** The folder under Agency's home that holds a folder per spawned program. */
const SPAWNED_DIR = "spawned";
const OUTPUT_FILE = "output.log";
const AGENCY_SUFFIX = ".agency";
const POLICY_FILE = "policy.json";
/** Only the user reads the policy a program was started with. */
const POLICY_FILE_MODE = 0o600;

/** Variables that tie a process to its caller's run: its trace, the config
 *  overrides the caller was started with, and the channel to a parent. */
const NOT_INHERITED = [TRACE_ID_ENV, CONFIG_OVERRIDES_ENV];
const NOT_INHERITED_PREFIX = "AGENCY_IPC";

/** What `std::spawn` asks about. The Agency side raises the interrupt
 *  with this value and then starts the program from the same value, so
 *  what was approved is what runs. */
export type SpawnQuestion = {
  dir: string;
  filename: string;
  node: string;
  args: string[];
  policy: Policy;
  maxCost: number | null;
  maxTime: number | null;
  messageCount: number;
  name: string;
  cwd: string;
  outputFile: string;
  depth: number;
};

/** Where one spawned program's files go. */
export type SpawnPaths = {
  /** The program's own folder under `~/.agency/spawned/`. */
  dir: string;
  /** The output file: the caller's, made absolute, or `output.log` in `dir`. */
  outputFile: string;
  /** The working directory: the caller's choice, made absolute, or the
   *  calling program's. */
  cwd: string;
};

/** How many `spawn` calls deep this process is: 0 for a program a person
 *  started. */
export function _spawnDepth(): number {
  const { ctx } = currentRun();
  const depth = Number(ctx.host.settings.read(AGENCY_SPAWN_DEPTH) ?? "");
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/** How many programs this run has started with spawn. */
export function _spawnCount(): number {
  const { ctx } = currentRun();
  return ctx.spawnCount;
}

/** Why these arguments cannot start a program, or null when they can.
 *  Checked before the interrupt, so nobody is asked to approve a start
 *  that would fail. The node name matters most: the command's target is
 *  `<file>:<node>`, and a node that is not a plain name would make the
 *  command read a different file than the one the approver was shown. */
export function _spawnProblem(
  filename: string,
  node: string,
  maxCost: number | null,
  maxTime: number | null,
): string | null {
  // The compiled file takes the source's name with `.agency` replaced. A
  // source with another name would be written over by its own output.
  if (!filename.endsWith(AGENCY_SUFFIX)) {
    return `"${filename}" is not an Agency file: its name must end in ${AGENCY_SUFFIX}.`;
  }
  if (!LEGAL_IDENTIFIER.test(node)) {
    return `"${node}" is not a node name.`;
  }
  if (maxCost !== null && !(Number.isFinite(maxCost) && maxCost >= 0)) {
    return `maxCost must be zero or more dollars, and ${maxCost} is not.`;
  }
  if (maxTime !== null && !(Number.isFinite(maxTime) && maxTime >= 1)) {
    return `maxTime must be at least one millisecond, and ${maxTime} is not.`;
  }
  return null;
}

/** Throws unless `filename` is a regular file in `dir`, with no link at
 *  the folder or below it. `spawn` calls it before the interrupt, so
 *  nobody is asked to approve a file that is not there. `_spawn` calls it
 *  again after the approval: a person can take a while to answer, and the
 *  file or a folder above it could be swapped for a link in that time.
 *
 *  The launcher is another process and reads the file a moment after the
 *  second check. That last gap stays open. */
export async function _checkSpawnFile(dir: string, filename: string): Promise<void> {
  const { ctx } = currentRun();
  const root = await ctx.host.files.fixedRoot(dir);
  const stat = await ctx.host.files.stat(root, filename);
  if (stat?.kind !== "file") {
    throw new Error(`${filename} is not a file in ${dir}.`);
  }
}

/** The paths one spawned program will use. Creates nothing: this runs
 *  before the interrupt, so that the payload can show the output file, and
 *  a rejected start leaves nothing on disk. */
export function _spawnPaths(outputFile: string | null, cwd: string | null): SpawnPaths {
  const { ctx } = currentRun();
  const here = ctx.host.system.cwd();
  const dir = path.join(agencyHomeDir(ctx.host), SPAWNED_DIR, ctx.host.random.id());
  return {
    dir,
    outputFile: outputFile == null ? path.join(dir, OUTPUT_FILE) : path.resolve(here, outputFile),
    cwd: cwd == null ? here : path.resolve(here, cwd),
  };
}

/** The `agency run` arguments that start `question`'s program. One row
 *  per flag: a null value leaves the flag out, and an empty one is a flag
 *  that takes no value. The `--` is always written, so the program's
 *  arguments are never read as `agency`'s. */
export function spawnCommand(
  question: SpawnQuestion,
  policyFile: string | null,
  seeded: boolean,
): string[] {
  const flags: [string, string | null][] = [
    ["--detach", question.outputFile],
    ["--wait-for-response", ""],
    ["--policy", policyFile],
    ["--name", question.name],
    ["--max-cost", question.maxCost === null ? null : String(question.maxCost)],
    ["--max-time", question.maxTime === null ? null : `${Math.round(question.maxTime)}ms`],
    ["--messages", seeded ? SEED_FROM_STDIN : null],
  ];
  const given = flags.flatMap(([flag, value]) =>
    value === null ? [] : value === "" ? [flag] : [flag, value],
  );
  const file = path.join(question.dir, question.filename);
  const target = `${file}:${question.node}`;
  // The command must read the target back as the file and the node that
  // were approved. `_spawnProblem` refuses a bad node before the
  // interrupt; this holds for any caller of this function.
  const read = parseTarget(target);
  if (read.filename !== file || read.nodeName !== question.node) {
    throw new Error(`"${question.node}" is not a node name.`);
  }
  return ["run", ...given, target, "--", ...question.args];
}

/** The environment a spawned program's launcher gets: `own` without the
 *  variables that tie a process to its caller's run, and with the depth.
 *  The program then has its own trace and reads its own `agency.json`. */
export function spawnEnvironment(
  own: Record<string, string>,
  depth: number,
): Record<string, string> {
  const kept = Object.entries(own).filter(
    ([name]) => !NOT_INHERITED.includes(name) && !name.startsWith(NOT_INHERITED_PREFIX),
  );
  return { ...Object.fromEntries(kept), [AGENCY_SPAWN_DEPTH]: String(depth) };
}

/** Whether a policy has any rule. One with none needs no file: the
 *  `--wait-for-response` flag alone installs an empty policy. */
function hasRules(policy: Policy): boolean {
  return Object.keys(policy).length > 0;
}

/** Make the program's folder, private to the user. */
async function makeSpawnDir(host: Host, spawnDir: string): Promise<Root> {
  const home = await host.files.root(agencyHomeDir(host));
  await host.files.mkdir(home, "");
  await host.files.privateDir(home, SPAWNED_DIR);
  const spawned = await host.files.root(path.dirname(spawnDir));
  await host.files.privateDir(spawned, path.basename(spawnDir));
  return host.files.root(spawnDir);
}

/** The pid in the one line of JSON the launcher prints last. */
function reportedPid(stdout: string): number {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const pid = (JSON.parse(last) as { pid?: unknown }).pid;
    if (typeof pid === "number") {
      return pid;
    }
  } catch {
    // Reported below.
  }
  throw new Error(`the command that starts the program did not report a pid: ${last}`);
}

/** Starts an approved program and returns its pid. Raises nothing: its
 *  only caller raised std::spawn first. `spawnDir` is the folder from
 *  `_spawnPaths`. The policy is written there for the launcher to read
 *  and removed once it has. The messages go to the launcher's standard
 *  input and are never written to a file. */
export async function _spawn(
  question: SpawnQuestion,
  messages: unknown[],
  spawnDir: string,
): Promise<{ pid: number }> {
  const { ctx } = currentRun();
  const host = ctx.host;
  await _checkSpawnFile(question.dir, question.filename);
  const ownOutput = path.dirname(question.outputFile) === spawnDir;
  const needsDir = ownOutput || hasRules(question.policy);
  const dir = needsDir ? await makeSpawnDir(host, spawnDir) : null;
  const policyFile = dir !== null && hasRules(question.policy) ? POLICY_FILE : null;
  if (dir !== null && policyFile !== null) {
    await host.files.writeText(dir, policyFile, JSON.stringify(question.policy), {
      mode: "create-only",
      fileMode: POLICY_FILE_MODE,
    });
  }
  const seeded = messages.length > 0;
  try {
    const result = await host.subprocess.run(
      program(process.execPath, [
        agencyCliPath(),
        ...spawnCommand(
          question,
          policyFile === null ? null : path.join(spawnDir, policyFile),
          seeded,
        ),
      ]),
      {
        cwd: question.cwd,
        env: spawnEnvironment(host.env.all(), question.depth),
        timeoutMs: SPAWN_LAUNCH_TIMEOUT_MS,
        input: seeded ? JSON.stringify(messages) : undefined,
      },
    );
    if (result.timedOut) {
      // The command may have started the program before it was stopped,
      // so the start is counted. The count must never run low.
      ctx.spawnCount += 1;
    }
    if (result.exitCode !== 0) {
      const why = result.timedOut ? "it took too long to start\n" : "";
      throw new Error(
        `Could not start ${question.filename}: ${why}${result.stderr.slice(-SPAWN_ERROR_TAIL_CHARS)}`,
      );
    }
    const pid = reportedPid(result.stdout);
    ctx.spawnCount += 1;
    return { pid };
  } finally {
    // The launcher has read the policy by now, or never will.
    // A removal that fails must not turn a start that worked into a failure.
    if (dir !== null && policyFile !== null) {
      await host.files.remove(dir, policyFile).catch(() => {});
    }
  }
}
