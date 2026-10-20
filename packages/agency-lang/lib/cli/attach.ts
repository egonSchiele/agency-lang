// `agency debug --attach [pid]`: list the programs that can take a
// debugger, or attach the terminal UI to one of them over its socket. The
// run side is lib/debugger/attach/server.ts; the design is
// docs/dev/cli/debugger-attach.md.
import { execFileSync } from "child_process";
import * as net from "net";
import * as path from "path";

import { nodeHost } from "@/host/node/nodeHost.js";
import { processState } from "@/runDirectory/lock.js";
import { ATTACH_SIGNAL } from "@/runtime/platform.node.js";
import { DebuggerUI } from "@/debugger/ui.js";
import { Screen, TerminalInput, TerminalOutput } from "@/tui/index.js";
import { lineChannel } from "@/debugger/attach/lineChannel.js";
import {
  ensureSessionsDir,
  listRecords,
  readRecord,
  recordPaths,
  removeRecord,
  removeStale,
  sessionsDir,
  type AttachRecord,
} from "@/debugger/attach/registry.js";
import { serveDebuggerIO } from "@/debugger/attach/serveIO.js";
import type { Channel } from "@/debugger/attach/channel.js";

/** `ps -o lstart=` has one-second resolution, and the record's time comes
 *  from `process.uptime`, so the two may differ by a little. */
export const START_TIME_TOLERANCE_MS = 2_000;
/** How long before its record a live process may have started and still
 *  be the one that wrote it: a wrapper script that does some work and
 *  then `exec`s node keeps the wrapper's start time. A process older than
 *  this is some other process with the same pid, which happens when the
 *  sessions directory is shared between machines or pid namespaces (a
 *  home on NFS, a container that mounts it); the record is then another
 *  machine's and is left alone. */
export const EARLY_START_LIMIT_MS = 5 * 60_000;
/** How long to keep trying to connect after the signal: the socket
 *  appears once the program's event loop handles the signal. */
const CONNECT_RETRY_MS = 2_000;
const CONNECT_RETRY_STEP_MS = 50;

export type AttachRefusal = { refused: string };

/** The listing `agency debug --attach` prints with no pid. A program's
 *  path is the one the process was started with, which `agency run`
 *  makes absolute; under `cwd` it is shown relative to it. */
export function formatListing(records: readonly AttachRecord[], now: number, cwd?: string): string {
  if (records.length === 0) {
    return "No running Agency programs can take a debugger.";
  }
  const shown = (program: string): string =>
    cwd !== undefined && program.startsWith(cwd + path.sep) ? path.relative(cwd, program) : program;
  const rows = records.map((record) => [
    String(record.pid),
    shown(record.program),
    record.node,
    `${formatElapsed(now - record.startedAt)} ago`,
  ]);
  const header = ["PID", "PROGRAM", "NODE", "STARTED"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]): string =>
    "  " +
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export type StartTime = { started: number } | { failed: string };

/** The start time `ps` reports for `pid`, as a timestamp, or why it could
 *  not be read: `ps` missing (a slim container), a `ps` that does not take
 *  `-o lstart` (BusyBox), or a date the parser cannot read. `ps` is run
 *  in the C locale, since `lstart` is otherwise printed in the user's
 *  language (`Di. 20 Okt. 15:47:40 2026` under German) and `Date.parse`
 *  reads only English; `TZ` is left alone so the time is in the zone
 *  `Date.parse` assumes. `ps` writes its own complaints to stderr, which
 *  is not shown. */
export function liveStartTime(pid: number): StartTime {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    return { failed: `could not run ps: ${(error as Error).message}` };
  }
  const started = parseStartTime(output);
  if (started === null) {
    return { failed: `could not read a date in what ps printed: "${output.trim()}"` };
  }
  return { started };
}

export function parseStartTime(output: string): number | null {
  const text = output.trim();
  if (text === "") {
    return null;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

/** The record for `pid`, when its process is the one the record is
 *  about. A run that crashes leaves its record behind, and the operating
 *  system may later give that pid to an unrelated process, which the
 *  attach signal would kill; so the live process is checked before
 *  anything is sent. A process that is gone has its record removed. One
 *  that is alive must have started around when the record was written:
 *  later than that, and it is a stranger that got the pid after the
 *  registered process exited, so the record is removed; more than
 *  `EARLY_START_LIMIT_MS` earlier, and it is a stranger that had the pid
 *  all along, which the record from another machine or pid namespace
 *  names by accident, so the record is kept and nothing is sent. A little
 *  earlier is the process itself, started by a wrapper that `exec`ed node.
 *  When `ps` cannot say, the attach is refused and the record kept: the
 *  program may well be running. */
export function checkedRecord(
  dir: string,
  pid: number,
  startTime: (pid: number) => StartTime = liveStartTime,
): AttachRecord | AttachRefusal {
  const record = readRecord(dir, pid);
  if (record === null) {
    return {
      refused: `no Agency program with pid ${pid} is registered for attach (run with no --attach to list them)`,
    };
  }
  if (processState(pid) === "gone") {
    removeRecord(dir, pid);
    return { refused: `pid ${pid} is not running; its record was removed` };
  }
  const live = startTime(pid);
  if ("failed" in live) {
    return { refused: `could not check the start time of pid ${pid}: ${live.failed}` };
  }
  if (live.started > record.startedAt + START_TIME_TOLERANCE_MS) {
    removeRecord(dir, pid);
    return {
      refused:
        `pid ${pid} is now a different process than the one that registered ` +
        `(started ${new Date(live.started).toLocaleString()}, the record was written ` +
        `${new Date(record.startedAt).toLocaleString()}); its record was removed`,
    };
  }
  if (live.started < record.startedAt - EARLY_START_LIMIT_MS) {
    return {
      refused:
        `pid ${pid} started ${new Date(live.started).toLocaleString()}, long before its record ` +
        `was written (${new Date(record.startedAt).toLocaleString()}), so it is not the process ` +
        `that registered; the record may be another machine's and was left alone`,
    };
  }
  return record;
}

/** Connect to `sock`, retrying while the program opens it. The retry's
 *  error listener comes off once connected, so a later error on the
 *  socket does not open a second connection. */
function connectWithRetry(pid: number, sock: string, retryMs: number): Promise<Channel> {
  const deadline = Date.now() + retryMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect(sock);
      const retry = (): void => {
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `pid ${pid} did not open its debug socket within ${Math.round(retryMs / 1000)} ` +
                `seconds; it may be busy, or its terminal may say why. Try again.`,
            ),
          );
          return;
        }
        setTimeout(attempt, CONNECT_RETRY_STEP_MS);
      };
      socket.once("error", retry);
      socket.once("connect", () => {
        socket.removeListener("error", retry);
        resolve(lineChannel(socket));
      });
    };
    attempt();
  });
}

export type AttachCommandOptions = {
  pid?: number;
  /** The UI to drive; the terminal UI when absent. A test passes its own. */
  ui?: DebuggerUI;
  /** Where lines for the person go before the UI is up, and where a
   *  refusal goes: stdout and stderr. */
  print?: (line: string) => void;
  printError?: (line: string) => void;
  retryMs?: number;
};

/** Run `agency debug --attach`. Resolves with the exit code: 0 when the
 *  session ended, 1 on a refusal. */
export async function attachCommand(options: AttachCommandOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const printError = options.printError ?? ((line: string) => console.error(line));
  const host = nodeHost();
  const dir = sessionsDir(host);
  const refusal = ensureSessionsDir(dir);
  if (refusal !== null) {
    printError(`Error: ${refusal.refused}`);
    return 1;
  }
  if (options.pid === undefined) {
    const records = listRecords(dir);
    removeStale(dir, records);
    print(formatListing(listRecords(dir), Date.now(), process.cwd()));
    return 0;
  }
  // Checked before the signal: a terminal UI with no terminal would fail
  // at its first key, and that failure would end the program's session
  // right after it opened.
  if (options.ui === undefined && !process.stdin.isTTY) {
    printError("Error: --attach reads keys from the terminal, and stdin is not one.");
    return 1;
  }
  const pid = options.pid;
  const record = checkedRecord(dir, pid);
  if ("refused" in record) {
    printError(`Error: ${record.refused}`);
    return 1;
  }
  try {
    process.kill(pid, ATTACH_SIGNAL);
  } catch (error) {
    printError(`Error: could not signal pid ${pid}: ${(error as Error).message}`);
    return 1;
  }
  let channel: Channel;
  try {
    channel = await connectWithRetry(
      pid,
      recordPaths(dir, pid).sock,
      options.retryMs ?? CONNECT_RETRY_MS,
    );
  } catch (error) {
    printError(`Error: ${(error as Error).message}`);
    return 1;
  }
  const ui = options.ui ?? terminalUI();
  return await new Promise<number>((resolve) => {
    let ended = false;
    let quit = false;
    const end = (line: string, code: number): void => {
      if (ended) {
        return;
      }
      ended = true;
      ui.destroy();
      (code === 0 ? print : printError)(line);
      resolve(code);
    };
    serveDebuggerIO(channel, ui, {
      hello: (hello) => ui.attachedTo(hello),
      finished: (value, error) =>
        end(
          error === undefined
            ? `Program finished. Return value: ${JSON.stringify(value)}`
            : `Program threw: ${error}`,
          0,
        ),
      refused: (reason) => end(`Error: ${reason}`, 1),
    });
    // A close the person did not ask for is the program's doing: it
    // threw, was killed, or its terminal went away.
    channel.onClose(() =>
      end(
        quit
          ? `Detached from pid ${pid}.`
          : `The connection to pid ${pid} closed; the program may have exited.`,
        0,
      ),
    );
    ui.onQuit(() => {
      quit = true;
      channel.close();
    });
  });
}

function terminalUI(): DebuggerUI {
  // Remove any keypress handlers on stdin left behind by readline, which
  // would conflict with TerminalInput's raw mode (as lib/cli/debug.ts does).
  process.stdin.removeAllListeners("data");
  delete (process.stdin as any)[Symbol.for("nodejs.readline.KEYPRESS_DECODER")];
  return new DebuggerUI(
    new Screen({
      input: new TerminalInput(),
      output: new TerminalOutput(),
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    }),
  );
}
