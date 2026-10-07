// The subprocess part of nodeHost, over child_process. Node-only.
//
// `run` collects the child's output and reports how it ended; what each
// ending means is the caller's decision (lib/stdlib/abortable.ts turns a
// cancelled child into an AgencyCancelledError, for example). A program
// that cannot be started rejects with Node's own error, so a caller can
// read `code === "ENOENT"`.

import { spawn, type ChildProcess } from "child_process";
import type { Command, HostSubprocess, RunOptions, RunResult, RunningProcess } from "./host.js";

/**
 * Stream teardown error codes that are safe to swallow. They mean the pipe
 * went away — the child exited or we killed it (byte-cap, timeout, abort) —
 * rather than a genuine failure. Everything else on a stdio stream is routed
 * to the promise's reject so it becomes a normal Failure at the call site.
 */
const BENIGN_STREAM_ERRORS = ["EPIPE", "ECONNRESET"];

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
    if (!BENIGN_STREAM_ERRORS.includes(err.code ?? "")) {
      reject(err);
    }
  });
}

function spawnCommand(command: Command, options: RunOptions): ChildProcess {
  const collect = options.collect ?? { stdout: true, stderr: true };
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", collect.stdout ? "pipe" : "ignore", collect.stderr ? "pipe" : "ignore"] as (
      "pipe" | "ignore"
    )[],
  };
  if (command.kind === "shell") {
    return spawn("sh", ["-c", command.script], spawnOptions);
  }
  return spawn(command.program, command.args, spawnOptions);
}

/** Collect a stream's text, keeping at most `limit` bytes when `limit`
 *  is positive. Past the limit the prefix that fits is kept and
 *  `onOverflow` runs once. */
function collector(
  limit: number,
  onOverflow: () => void,
): {
  take: (data: string) => void;
  text: () => string;
} {
  let text = "";
  let bytes = 0;
  let full = false;
  return {
    take(data) {
      if (full) {
        return;
      }
      if (limit > 0) {
        const chunkBytes = Buffer.byteLength(data, "utf8");
        if (bytes + chunkBytes > limit) {
          // Keep only the byte-prefix that fits, so memory stays bounded
          // even when the child delivers one large chunk.
          text += Buffer.from(data, "utf8")
            .subarray(0, limit - bytes)
            .toString("utf8");
          full = true;
          onOverflow();
          return;
        }
        bytes += chunkBytes;
      }
      text += data;
    },
    text: () => text,
  };
}

/** Start the child, wire its output, input, timeout, and signal, and
 *  settle `ended` when it closes. */
function startChild(
  command: Command,
  options: RunOptions,
): { child: ChildProcess; ended: Promise<RunResult>; kill: RunningProcess["kill"] } {
  const child = spawnCommand(command, options);
  let truncated: "stdout" | "stderr" | null = null;
  let timedOut = false;
  let aborted = false;
  const maxOutputBytes = options.maxOutputBytes ?? 0;
  const killSignal = options.killSignal ?? "SIGTERM";
  const kill: RunningProcess["kill"] = (signal) => {
    child.kill(signal ?? killSignal);
  };
  // Each stream has its own limit, as execFile's maxBuffer works. The
  // first to overflow is the one reported.
  const overflow = (stream: "stdout" | "stderr") => () => {
    if (truncated === null) {
      truncated = stream;
    }
    kill();
  };
  const stdout = collector(maxOutputBytes, overflow("stdout"));
  const stderr = collector(maxOutputBytes, overflow("stderr"));

  const ended = new Promise<RunResult>((resolve, reject) => {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", stdout.take);
    child.stderr?.on("data", stderr.take);

    // Guard every stdio stream against a stray `error` event, or an unhandled
    // one crashes the process. The common case is EPIPE on stdin: a child that
    // ignores stdin (a file reader like `hexdump`) or exits early closes its
    // stdin pipe with no reader, so our write raises EPIPE. stdout/stderr can
    // likewise emit late errors when we kill the child mid-read.
    guardStdioStream(child.stdin, reject);
    guardStdioStream(child.stdout, reject);
    guardStdioStream(child.stderr, reject);
    if (options.input !== undefined && options.input.length > 0) {
      child.stdin!.end(options.input);
    } else {
      child.stdin!.end();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
    }
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("close", (code, endedBy) => {
      cleanup();
      resolve({
        exitCode: code,
        signal: endedBy,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated,
        timedOut,
        aborted,
      });
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
  return { child, ended, kill };
}

export const nodeSubprocess: HostSubprocess = {
  run: (command, options = {}) => startChild(command, options).ended,
  start: async (command, options = {}) => {
    const { ended, kill } = startChild(command, options);
    // A rejection with nobody waiting yet must not be unhandled; `wait`
    // hands it to the caller.
    ended.catch(() => undefined);
    return { kill, wait: () => ended };
  },
};
