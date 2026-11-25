import { spawn } from "child_process";

import { groupKill, supervise } from "./run/childSupervisor.js";

/** How much of a command's output a failure message carries. */
export const OUTPUT_TAIL_CHARS = 2000;

const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export type ShellOptions = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };

export type ShellResult = {
  status: number | null;
  output: string;
  timedOut: boolean;
  /** The process got a terminating signal while the command ran, or before
   *  it could start. */
  interrupted: boolean;
};

/** Set by the first terminating signal that reaches a running command. After
 *  that no further command starts: whoever pressed Ctrl-C is waiting, and a
 *  suite's remaining setup and grader commands can each take many minutes. */
let interrupted = false;

/** @internal */
export function resetShellInterruptForTests(): void {
  interrupted = false;
}

/** Whether a terminating signal has reached a command in this process. */
export function shellInterrupted(): boolean {
  return interrupted;
}

/** Run `sh -c command` without blocking the event loop. `env` is the whole
 *  environment: the caller merges `process.env` itself. Output is stdout and
 *  stderr interleaved in the order they arrive, and when it passes the byte
 *  cap the oldest part is dropped, because an error is printed last.
 *
 *  The command gets its own process group, so the timeout kills everything
 *  it started, not just the shell: a timed-out `make` must not keep compiling
 *  in the workdir while the next command runs there. A detached group no
 *  longer gets the terminal's Ctrl-C, so the child is registered with the
 *  supervisor every eval child uses, which forwards terminating signals to
 *  the group and reaps it when this process exits.
 *
 *  At the timeout the result is settled at once, so a process the command
 *  left holding the output pipe cannot keep the caller waiting. */
export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  if (interrupted) {
    return Promise.resolve({
      status: null,
      output: "interrupted",
      timedOut: false,
      interrupted: true,
    });
  }
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const killTree = groupKill(child);
    let chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer): void => {
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > OUTPUT_MAX_BYTES && chunks.length > 1) {
        bytes -= chunks[0].length;
        chunks = chunks.slice(1);
      }
    };
    const output = (): string => Buffer.concat(chunks).toString("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    let signalled = false;
    const settle = (result: Omit<ShellResult, "interrupted">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsupervise();
      resolve({ ...result, interrupted: signalled });
    };
    const unsupervise = supervise((signal) => {
      interrupted = true;
      signalled = true;
      // The shell may trap a polite signal; the whole group must be gone
      // before anything else touches the workdir.
      killTree(signal);
      killTree("SIGKILL");
      settle({ status: null, output: output(), timedOut: false });
    });
    const timer = setTimeout(() => {
      killTree("SIGKILL");
      settle({ status: null, output: output(), timedOut: true });
    }, options.timeoutMs);
    child.on("error", (error) => settle({ status: null, output: error.message, timedOut: false }));
    child.on("close", (status) => settle({ status, output: output(), timedOut: false }));
  });
}

/** The end of a command's output, where its error is. */
export function outputTail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}
