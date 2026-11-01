// The subprocess part of nodeHost, over child_process. Node-only.
//
// `run` collects the child's output and reports how it ended; what each
// ending means is the caller's decision (lib/stdlib/abortable.ts turns a
// cancelled child into an AgencyCancelledError, for example). A `program`
// command that cannot be started rejects with Node's own error, so a caller
// can read `code === "ENOENT"`. A `shell` command runs under bash, found on
// the search path; with no bash it rejects with a message that names bash.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import type { Command, HostSubprocess, RunOptions, RunResult, RunningProcess } from "../host.js";

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

/** The variables of an environment that have a value. `process.env` can
 *  hold undefined for a variable deleted with `delete`; a child's
 *  environment cannot. */
export function definedVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** Variables removed from a shell script's environment, because each makes
 *  bash do something the script does not say. */
const SHELL_ENV_REMOVED = [
  // Names a file bash sources before the script.
  "BASH_ENV",
  // Starts bash in POSIX mode, where macOS bash 3.2 prints `echo -n hi` as
  // `-n hi` and reads backslash escapes. `+o posix` does not undo it. GNU
  // programs in the child also stop reading options in POSIX order, which
  // changes no safeBash plan: the flag tables that care set optionsFirst.
  "POSIXLY_CORRECT",
  // Turn on shell options at startup; `xpg_echo` would change what `echo`
  // prints. bash reads BASHOPTS from 4.1 on.
  "SHELLOPTS",
  "BASHOPTS",
  // Sends `cd target` to $CDPATH/target and prints the folder.
  "CDPATH",
  // Drops names from a glob's expansion.
  "GLOBIGNORE",
];

/** An exported function arrives as `BASH_FUNC_<name>%%` (bash 4.3 and
 *  later) or `BASH_FUNC_<name>()` (older), and shadows the program of that
 *  name, so `git status` would run the function instead of git. */
const SHELL_ENV_REMOVED_PREFIX = "BASH_FUNC_";

/** The environment a shell script runs with: `env` without the variables
 *  above. */
export function shellEnvironment(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SHELL_ENV_REMOVED.includes(key) && !key.startsWith(SHELL_ENV_REMOVED_PREFIX)) {
      out[key] = value;
    }
  }
  return out;
}

/** The first executable file named `program` in the folders of
 *  `searchPath`, or null. Synchronous because a shell script's spawn uses
 *  it, and `startChild` hands back `kill` before anything settles. A
 *  relative entry is skipped: it would resolve against the working
 *  directory, which an agent writes into. */
export function locateProgramSync(program: string, searchPath: string): string | null {
  const dirs = searchPath.split(path.delimiter).filter((d) => path.isAbsolute(d));
  const isWindows = process.platform === "win32";
  const extensions = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, program + ext);
      try {
        if (!fs.statSync(candidate).isFile()) {
          continue;
        }
        if (!isWindows) {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return candidate;
      } catch {
        // not here, or not executable: try the next one
      }
    }
  }
  return null;
}

function spawnCommand(command: Command, options: RunOptions): ChildProcess {
  const collect = options.collect ?? { stdout: true, stderr: true };
  const stdio = [
    "pipe",
    collect.stdout ? "pipe" : "ignore",
    collect.stderr ? "pipe" : "ignore",
  ] as ("pipe" | "ignore")[];
  if (command.kind === "shell") {
    const env = options.env ?? definedVariables(process.env);
    const bash = locateProgramSync("bash", env.PATH ?? "");
    if (bash === null) {
      throw new Error(
        "bash was not found on the PATH. safeBash and the bash tool run their commands with bash.",
      );
    }
    return spawn(bash, ["-c", command.script], {
      cwd: options.cwd,
      env: shellEnvironment(env),
      stdio,
    });
  }
  return spawn(command.program, command.args, { cwd: options.cwd, env: options.env, stdio });
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
  // `async`, so a throw from `spawnCommand` (no bash) is a rejection.
  run: async (command, options = {}) => startChild(command, options).ended,
  locate: async (program) => locateProgramSync(program, process.env.PATH ?? ""),
  start: async (command, options = {}) => {
    const { ended, kill } = startChild(command, options);
    // A rejection with nobody waiting yet must not be unhandled; `wait`
    // hands it to the caller.
    ended.catch(() => undefined);
    return { kill, wait: () => ended };
  },
};
