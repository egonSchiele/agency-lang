import type { Command, Host, RunOptions, RunResult } from "../host/host.js";
import { AgencyCancelledError, isAbortError, readCause } from "../runtime/errors.js";

/**
 * Build the cancellation a leaf op rejects with when its abort signal
 * fires. Reads the structured `AbortCause` off the signal (a guard trip,
 * a user interrupt, …) and carries it on the error so the boundary that
 * catches it — e.g. the stdlib `guard`'s `try` via `__tryCall` — can
 * convert it instead of letting a bare cancel escape. Falls back to a
 * plain cancel when no structured cause is present.
 */
function leafCancel(message: string, signal: AbortSignal | undefined): AgencyCancelledError {
  return new AgencyCancelledError(message, readCause(signal));
}

/**
 * The stdlib's ways of running a program through `host.subprocess`. The
 * host reports how a child ended; the functions here decide what each
 * ending means, so every caller gets the same contract: a child killed
 * because the run's abort signal fired rejects with
 * `AgencyCancelledError`, which `__tryCall` re-throws.
 */

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type AbortableSpawnOptions = {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  /** Time limit in ms. 0 or undefined = no time limit. */
  timeout?: number;
  /** When set, an abort fires the same teardown path as the timeout
   *  and the returned promise rejects with `AgencyCancelledError`. */
  signal?: AbortSignal;
  /** Max stdout to buffer, in UTF-8 bytes. Once exceeded the child is
   *  killed, stdout is marked truncated (a note is appended), and the
   *  call resolves successfully with the partial output. 0/undefined =
   *  unbounded. Keeps auto-approved reads (e.g. a huge `git diff`) from
   *  buffering unbounded memory. */
  maxOutputBytes?: number;
};

/** `command` as the host takes it: a program with its arguments. */
export function program(name: string, args: string[]): Command {
  return { kind: "program", program: name, args };
}

/** Run `command` and wait, with the run's cancellation applied: a child
 *  killed because `signal` fired rejects with `AgencyCancelledError`. */
async function runCancellable(
  host: Host,
  command: Command,
  options: RunOptions,
  describe: string,
): Promise<RunResult> {
  if (options.signal?.aborted) {
    throw leafCancel(`${describe} cancelled`, options.signal);
  }
  let result: RunResult;
  try {
    result = await host.subprocess.run(command, options);
  } catch (err) {
    if (options.signal?.aborted || isAbortError(err)) {
      throw leafCancel(`${describe} cancelled`, options.signal);
    }
    throw err;
  }
  if (result.aborted) {
    throw leafCancel(`${describe} cancelled`, options.signal);
  }
  return result;
}

/**
 * Run `command` with `args` and collect its output. A timeout resolves
 * with exit code 1 and a note in stderr; the byte cap resolves with the
 * partial output and a note in stdout; an abort rejects with
 * `AgencyCancelledError`.
 */
export async function abortableSpawn(
  host: Host,
  command: string,
  args: string[],
  options: AbortableSpawnOptions,
): Promise<SpawnResult> {
  return spawnResultOf(
    command,
    options,
    await runCancellable(
      host,
      program(command, args),
      {
        cwd: options.cwd,
        env: options.env,
        input: options.input,
        timeoutMs: options.timeout,
        signal: options.signal,
        maxOutputBytes: options.maxOutputBytes,
      },
      command,
    ),
  );
}

/** `abortableSpawn` for a script the platform's shell runs. */
export async function abortableShell(
  host: Host,
  script: string,
  options: AbortableSpawnOptions,
): Promise<SpawnResult> {
  return spawnResultOf(
    "sh",
    options,
    await runCancellable(
      host,
      { kind: "shell", script },
      {
        cwd: options.cwd,
        env: options.env,
        input: options.input,
        timeoutMs: options.timeout,
        signal: options.signal,
        maxOutputBytes: options.maxOutputBytes,
      },
      "sh",
    ),
  );
}

function spawnResultOf(
  command: string,
  options: AbortableSpawnOptions,
  result: RunResult,
): SpawnResult {
  if (result.truncated) {
    // We killed the child on purpose after hitting the byte cap; treat
    // the partial output as a success rather than a spawn failure.
    return {
      stdout: result.stdout + `\n[output truncated at ${options.maxOutputBytes} bytes]`,
      stderr: result.stderr,
      exitCode: 0,
    };
  }
  if (result.timedOut) {
    return { stdout: result.stdout, stderr: result.stderr + "\nProcess timed out", exitCode: 1 };
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

/**
 * Run a child whose output is not wanted, with the same abort-on-signal
 * behavior. Used for `_say` (the `say` command), `_screenshot`, `_openUrl`,
 * etc. — anything where we just want to wait for the child to exit,
 * getting an `AgencyCancelledError` if the run is cancelled.
 *
 * Distinct from `abortableSpawn` so callers that don't want stdout
 * piping (some of these run for minutes streaming audio to the
 * speakers and would buffer indefinitely) get the right behavior. A
 * non-zero exit, or a signal nobody here sent, rejects with the
 * child's standard error in the message.
 */
export async function abortableExec(
  host: Host,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runCancellable(
    host,
    program(command, args),
    { signal, collect: { stdout: false, stderr: true } },
    command,
  );
  if (result.exitCode === 0) {
    return;
  }
  if (result.exitCode === null) {
    throw new Error(`${command} killed by signal ${result.signal}: ${result.stderr}`);
  }
  throw new Error(`${command} exited with code ${result.exitCode}: ${result.stderr}`);
}

/** The failure `runProgram` rejects with for a child that did not exit
 *  with 0 or wrote past the output limit, carrying its output the way
 *  Node's `execFile` does. `ending` says which. */
export class ProgramFailed extends Error {
  constructor(
    command: string,
    ending: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${command} ${ending}: ${stderr.trim()}`);
    this.name = "ProgramFailed";
  }
}

/** How much of each output stream `runProgram` keeps unless the caller
 *  says otherwise: the default `maxBuffer` of Node's `execFile`. */
export const PROGRAM_OUTPUT_LIMIT = 1024 * 1024;

/**
 * Run `command` with `args` and return its output, rejecting with
 * `ProgramFailed` when it does not exit with 0 or writes more than the
 * output limit to one stream, and with the host's error when it cannot
 * be started. The contract of Node's `execFile`, for the helpers that
 * call a fixed program such as `osascript` or `security`.
 */
export async function runProgram(
  host: Host,
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const limit = options.maxOutputBytes ?? PROGRAM_OUTPUT_LIMIT;
  const result = await host.subprocess.run(program(command, args), {
    ...options,
    maxOutputBytes: limit,
  });
  if (result.truncated) {
    // The child may still have exited with 0, if it finished before the
    // kill reached it. Partial output is not its output.
    throw new ProgramFailed(
      command,
      `wrote more than ${limit} bytes`,
      result.exitCode,
      result.stdout,
      result.stderr,
    );
  }
  if (result.exitCode !== 0) {
    const ending = result.exitCode === null ? "was killed" : `exited with code ${result.exitCode}`;
    throw new ProgramFailed(command, ending, result.exitCode, result.stdout, result.stderr);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Sleep that wakes up early on abort. The default `setTimeout`-based
 * sleep ignores cancellation entirely; a 10-minute `sleep(10m)` after
 * Ctrl-C would just sit there for ten minutes. Translates to
 * `AgencyCancelledError` so `__tryCall` re-throws it.
 */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(leafCancel("sleep cancelled", signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(leafCancel("sleep cancelled", signal));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
