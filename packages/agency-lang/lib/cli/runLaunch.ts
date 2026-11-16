// What `agency run` and `agency resume` are told about how to start the
// program, from the flags `--name`, `--messages`, and `--detach`
// (docs/dev/runtime/spawn.md).
import * as fs from "fs";
import * as path from "path";

import { SEED_FROM_STDIN } from "@/constants.js";

/** What a run is told about how it was started. */
export type RunLaunch = {
  /** The title for `ps`. */
  title: string;
  /** The seed for the first thread: a file's path, or `-` for this
   *  command's standard input. */
  seedMessages?: string;
  /** When set, the program starts detached, with its output saved to
   *  this file. */
  detachedOutputFile?: string;
};

export type LaunchFlags = {
  name?: string;
  messages?: string;
  detach?: string;
};

export type LaunchRefusal = { refused: string };

/** The words `ps` shows before a run's name. */
const TITLE_PREFIX = "agency run ";

/** The seed value to carry for `--messages <value>`, or why it is refused.
 *  A path is made absolute, and must name a real file that holds a JSON
 *  list. `-` is standard input, which only a detached program is given:
 *  otherwise the program's standard input is the terminal. */
export function seedSource(value: string, detached: boolean, cwd: string): string | LaunchRefusal {
  if (value === SEED_FROM_STDIN) {
    return detached
      ? value
      : { refused: "--messages - reads standard input, which needs --detach" };
  }
  const file = path.resolve(cwd, value);
  let text: string;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return { refused: `--messages: ${file} is a symbolic link` };
    }
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { refused: `--messages: could not read ${file}: ${(error as Error).message}` };
  }
  const problem = seedProblem(text);
  return problem === null ? file : { refused: `--messages: ${file} ${problem}` };
}

/** Why `text` is not a seed, as the end of a sentence, or null when it is
 *  one: a JSON list. */
export function seedProblem(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `is not valid JSON: ${(error as Error).message}`;
  }
  return Array.isArray(parsed) ? null : "does not hold a JSON list of messages";
}

/** The launch for a run of `input` with these flags, or why a flag is
 *  refused. The name defaults to the input file's name. */
export function runLaunchFrom(
  flags: LaunchFlags,
  input: string,
  cwd: string,
): RunLaunch | LaunchRefusal {
  const launch: RunLaunch = { title: TITLE_PREFIX + (flags.name ?? path.basename(input)) };
  if (flags.detach !== undefined) {
    launch.detachedOutputFile = path.resolve(cwd, flags.detach);
  }
  if (flags.messages !== undefined) {
    const seed = seedSource(flags.messages, flags.detach !== undefined, cwd);
    if (typeof seed !== "string") {
      return seed;
    }
    launch.seedMessages = seed;
  }
  return launch;
}
