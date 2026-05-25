import { spawn, SpawnOptions, ChildProcess } from "child_process";
import { AgencyCancelledError, isAbortError } from "../runtime/errors.js";

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

export type AbortableSpawnOptions = SpawnOptions & {
  input?: string;
  /** Time limit in ms. 0 or undefined = no time limit. */
  timeout?: number;
  /** When set, an abort fires the same teardown path as the timeout
   *  and the returned promise rejects with `AgencyCancelledError`. */
  signal?: AbortSignal;
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
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => { stdout += data; });
    child.stderr!.on("data", (data: string) => { stderr += data; });

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
        reject(new AgencyCancelledError(`${command} cancelled`));
      } else if (timedOut) {
        resolve({ stdout, stderr: stderr + "\nProcess timed out", exitCode: 1 });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
    child.on("error", (err) => {
      cleanup();
      if (aborted || isAbortError(err)) {
        reject(new AgencyCancelledError(`${command} cancelled`));
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
    const child: ChildProcess = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let aborted = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => { stderr += data; });

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

    child.on("close", (code) => {
      cleanup();
      if (aborted) {
        reject(new AgencyCancelledError(`${command} cancelled`));
      } else if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });
    child.on("error", (err) => {
      cleanup();
      if (aborted || isAbortError(err)) {
        reject(new AgencyCancelledError(`${command} cancelled`));
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
      reject(new AgencyCancelledError("sleep cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgencyCancelledError("sleep cancelled"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
