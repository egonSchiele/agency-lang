/** How a command is run inside a sandbox. `shellLine` turns `user`, `cwd`
 *  and `env` into one line; a provider only ever sees the finished line. */
export type ExecOptions = {
  /** Run as this user. Default: root. */
  user?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Default 600. */
  timeoutSec?: number;
};

export type ExecResult = { exitCode: number; output: string };

export const DEFAULT_TIMEOUT_SEC = 600;

/** A disposable machine. Everything else in this folder is a function over
 *  this interface, so only the provider knows which service is behind it. */
export type Sandbox = {
  readonly id: string;
  /** Runs `command` with bash and waits. A non-zero exit is a result, not a
   *  throw. Running past `timeoutSec` (default 600) throws
   *  SandboxTimeoutError; a failure of the provider throws its own error. */
  exec(command: string, options?: { timeoutSec?: number }): Promise<ExecResult>;
  /** Starts `command` as root and returns at once. The command outlives the call. */
  startBackground(command: string): Promise<void>;
  upload(content: Buffer, remotePath: string): Promise<void>;
  /** Throws when the file is missing. */
  download(remotePath: string): Promise<Buffer>;
  delete(): Promise<void>;
};

/** A command ran past its time limit. Kept apart from every other failure
 *  of `exec`: a build that is too slow is the patch's fault, while a dropped
 *  connection is nobody's, and graders must not confuse the two. */
export class SandboxTimeoutError extends Error {
  constructor(command: string, timeoutSec: number) {
    super(`${command.slice(0, 80)} did not finish within ${timeoutSec}s`);
    this.name = "SandboxTimeoutError";
  }
}

const TAIL_CHARS = 3000;

export class SandboxCommandError extends Error {
  readonly outputTail: string;
  constructor(
    readonly label: string,
    readonly exitCode: number,
    output: string,
  ) {
    const tail = output.slice(-TAIL_CHARS);
    super(`${label} failed (exit ${exitCode}):\n${tail}`);
    this.name = "SandboxCommandError";
    this.outputTail = tail;
  }
}
