import { spawn, SpawnOptions, ChildProcess } from "child_process";
import {
  AgencyCancelledError,
  isAbortError,
  readCause,
} from "../runtime/errors.js";

/**
 * Build the cancellation a leaf op rejects with when its abort signal
 * fires. Reads the structured `AbortCause` off the signal (a guard trip,
 * a user interrupt, …) and carries it on the error so the boundary that
 * catches it — e.g. the stdlib `guard`'s `try` via `__tryCall` — can
 * convert it instead of letting a bare cancel escape. Falls back to a
 * plain cancel when no structured cause is present.
 */
function leafCancel(
  message: string,
  signal: AbortSignal | undefined,
): AgencyCancelledError {
  return new AgencyCancelledError(message, readCause(signal));
}

/**
 * Shared abortability helpers for stdlib JS implementations whose
 * underlying API doesn't natively support `AbortSignal`. Used by
 * `shell.ts`, `speech.ts`, and `system.ts` to (1) thread cancellation
 * through `child_process.spawn` and `execFile`, and (2) cancel a
 * `setTimeout`-based sleep on abort.
 *
 * Why a separate file: each call site that needs cancellation has to
 * (a) listen to the signal, (b) tear down the in-flight resource,
 * (c) translate the resulting "killed by signal" outcome into an
 * `AgencyCancelledError` so `__tryCall` re-throws it. Doing that
 * inline once per caller is bug-prone (forget any of the three and
 * cancellation silently breaks for that function). Centralizing them
 * keeps the contract identical across the stdlib.
 */

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Stream teardown error codes that are safe to swallow. They mean the pipe
 * went away — the child exited or we killed it (byte-cap, timeout, abort) —
 * rather than a genuine failure. Everything else on a stdio stream is routed
 * to the promise's reject so it becomes a normal Failure at the call site.
 */
const BENIGN_STREAM_ERRORS = new Set(["EPIPE", "ECONNRESET"]);

/**
 * Attach an `error` listener to a child's stdio stream. Each of stdin/stdout/
 * stderr is its own EventEmitter, and an `error` event with no listener is
 * re-thrown by Node from an event-loop tick — outside any try/catch — which
 * crashes the whole process instead of converting to a Failure. `child.on
 * ("error")` does NOT cover these; the stream emitters need their own guard.
 */
function guardStdioStream(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined,
  reject: (err: unknown) => void,
): void {
  stream?.on("error", (err: NodeJS.ErrnoException) => {
    if (!BENIGN_STREAM_ERRORS.has(err.code ?? "")) {
      reject(err);
    }
  });
}

export type AbortableSpawnOptions = SpawnOptions & {
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

/**
 * `child_process.spawn` accepts a `signal` option natively as of
 * Node 16, but that path only kills the child with SIGTERM and
 * surfaces an `AbortError` on the child's emitter — it doesn't
 * give us the "translate to `AgencyCancelledError` and reject the
 * outer promise" behavior we want. So we register our own listener
 * and call `child.kill()` explicitly, which is the same code path
 * the existing timeout uses.
 */
export function abortableSpawn(
  command: string,
  args: string[],
  options: AbortableSpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Strip our custom keys out before handing to Node. `signal` in
    // particular: we handle it ourselves (see the docblock above) and
    // don't want Node's built-in handler racing with ours.
    const { signal: _sig, input: _in, timeout: _to, ...spawnOptions } = options;
    if (options.signal?.aborted) {
      reject(leafCancel(`${command} cancelled`, options.signal));
      return;
    }
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maxOutputBytes = options.maxOutputBytes ?? 0;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      if (truncated) return;
      if (maxOutputBytes > 0) {
        const chunkBytes = Buffer.byteLength(data, "utf8");
        if (stdoutBytes + chunkBytes > maxOutputBytes) {
          // Append only the byte-prefix that fits, then kill the child so
          // memory stays bounded even if git delivers one large chunk.
          const remaining = maxOutputBytes - stdoutBytes;
          stdout += Buffer.from(data, "utf8").subarray(0, remaining).toString("utf8");
          truncated = true;
          child.kill("SIGTERM");
          return;
        }
        stdoutBytes += chunkBytes;
      }
      stdout += data;
    });
    child.stderr!.on("data", (data: string) => { stderr += data; });

    // Guard every stdio stream against a stray `error` event, or an unhandled
    // one crashes the process. The common case is EPIPE on stdin: a child that
    // ignores stdin (a file reader like `hexdump`) or exits early closes its
    // stdin pipe with no reader, so our write raises EPIPE. stdout/stderr can
    // likewise emit late errors when we kill the child mid-read.
    guardStdioStream(child.stdin, reject);
    guardStdioStream(child.stdout, reject);
    guardStdioStream(child.stderr, reject);
    if (options.input) {
      child.stdin!.write(options.input);
      child.stdin!.end();
    } else {
      child.stdin!.end();
    }

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeout);
    }

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };

    child.on("close", (code) => {
      cleanup();
      if (aborted) {
        reject(leafCancel(`${command} cancelled`, options.signal));
      } else if (truncated) {
        // We killed the child on purpose after hitting the byte cap; treat
        // the partial output as a success rather than a spawn failure.
        resolve({ stdout: stdout + `\n[output truncated at ${maxOutputBytes} bytes]`, stderr, exitCode: 0 });
      } else if (timedOut) {
        resolve({ stdout, stderr: stderr + "\nProcess timed out", exitCode: 1 });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
    child.on("error", (err) => {
      cleanup();
      if (aborted || isAbortError(err)) {
        reject(leafCancel(`${command} cancelled`, options.signal));
        return;
      }
      reject(err);
    });
  });
}

/**
 * Spawn a child that we don't need to read output from, with the
 * same abort-on-signal behavior. Used for `_speak` (the `say`
 * command), `_screenshot`, `_openUrl`, etc. — anything where we
 * just want to wait for the child to exit, getting an
 * `AgencyCancelledError` if the run is cancelled.
 *
 * Distinct from `abortableSpawn` so callers that don't want stdout
 * piping (some of these run for minutes streaming audio to the
 * speakers and would buffer indefinitely) get the right behavior.
 */
export function abortableExec(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(leafCancel(`${command} cancelled`, signal));
      return;
    }
    const child: ChildProcess = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let aborted = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => { stderr += data; });
    // stdin/stdout are `ignore`d here (no stream), but stderr is piped and,
    // like any stdio emitter, crashes the process on an unhandled `error`.
    guardStdioStream(child.stdin, reject);
    guardStdioStream(child.stdout, reject);
    guardStdioStream(child.stderr, reject);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.on("close", (code, sig) => {
      cleanup();
      if (aborted) {
        reject(leafCancel(`${command} cancelled`, signal));
      } else if (code === 0) {
        resolve();
      } else if (code === null) {
        // Child exited due to a signal we didn't send (aborted is false).
        // Surface it so callers don't see a silent success.
        reject(new Error(`${command} killed by signal ${sig}: ${stderr}`));
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });
    child.on("error", (err) => {
      cleanup();
      if (aborted || isAbortError(err)) {
        reject(leafCancel(`${command} cancelled`, signal));
        return;
      }
      reject(err);
    });
  });
}

/**
 * Sleep that wakes up early on abort. The default `setTimeout`-based
 * sleep ignores cancellation entirely; a 10-minute `sleep(10m)` after
 * Ctrl-C would just sit there for ten minutes. Translates to
 * `AgencyCancelledError` so `__tryCall` re-throws it.
 */
export function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
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
