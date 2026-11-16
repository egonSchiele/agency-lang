// The detached start behind `agency run --detach <output-file>`: the
// program runs in its own process group with its output saved to a file,
// and the command returns at once (docs/dev/runtime/spawn.md).
import { spawn } from "child_process";
import * as fs from "fs";

import { EXIT_CODE_USAGE_ERROR } from "@/constants.js";
import { seedProblem } from "./runLaunch.js";

/** Only the user reads a program's saved output. The mode applies when
 *  the file is created; an existing file keeps its mode. */
const OUTPUT_FILE_MODE = 0o600;
const STDIN = 0;

export type DetachedStart = {
  /** Node's arguments: its flags, the compiled program, the program's own. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Where both of the program's output streams are appended. */
  outputFile: string;
  /** Whether the seed messages are on this command's standard input. */
  seedFromStdin: boolean;
};

/** What the command prints, as one line of JSON, once the program started. */
export type DetachedReport = { pid: number; outputFile: string };

function refuse(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(EXIT_CODE_USAGE_ERROR);
}

/** Open `file` for appending, creating it when missing. A symbolic link
 *  at the path is refused, not followed. */
function openOutputFile(file: string): number {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
  try {
    return fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, OUTPUT_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ELOOP" ? "it is a symbolic link" : (error as Error).message;
    refuse(`--detach: could not open the output file ${file}: ${reason}`);
  }
}

/** This command's whole standard input, checked to be a list of messages. */
function seedFromStandardInput(): string {
  const text = fs.readFileSync(STDIN, "utf8");
  const problem = seedProblem(text);
  if (problem !== null) {
    refuse(`--messages -: standard input ${problem}`);
  }
  return text;
}

/** Start the program detached and print its pid and output file as one
 *  line of JSON. The seed, when there is one, goes to the program's
 *  standard input and never to a file. The command exits once the seed is
 *  written: nothing here keeps it alive after that. */
export function startDetached(start: DetachedStart): void {
  const seed = start.seedFromStdin ? seedFromStandardInput() : null;
  const out = openOutputFile(start.outputFile);
  const child = spawn(process.execPath, start.argv, {
    stdio: [seed === null ? "ignore" : "pipe", out, out],
    // Its own process group, so Ctrl-C in this terminal does not reach it.
    detached: true,
    shell: false,
    env: start.env,
  });
  fs.closeSync(out);
  child.on("error", (error) => {
    console.error(`Failed to start the program: ${error.message}`);
    process.exit(1);
  });
  if (child.pid === undefined) {
    // The start failed, and the error listener above reports it.
    return;
  }
  if (seed !== null) {
    // A program that ends before it reads its seed closes the pipe, and
    // the write fails. That is the program's failure, which its output
    // file shows. It must not crash this command after the report.
    child.stdin?.on("error", () => {});
    child.stdin?.end(seed);
  }
  child.unref();
  const report: DetachedReport = { pid: child.pid, outputFile: start.outputFile };
  console.log(JSON.stringify(report));
}
