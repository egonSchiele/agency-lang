// `agency debug --attach [pid]`: list the programs that can take a
// debugger, or attach the terminal UI to one of them over its socket. The
// run side is lib/debugger/attach/server.ts; the design is
// docs/dev/cli/debugger-attach.md.
import { execFileSync } from "child_process";
import * as net from "net";

import { nodeHost } from "@/host/node/nodeHost.js";
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
/** How long to keep trying to connect after the signal: the socket
 *  appears once the program's event loop handles the signal. */
const CONNECT_RETRY_MS = 2_000;
const CONNECT_RETRY_STEP_MS = 50;

export type AttachRefusal = { refused: string };

/** The listing `agency debug --attach` prints with no pid. */
export function formatListing(records: readonly AttachRecord[], now: number): string {
  if (records.length === 0) {
    return "No running Agency programs can take a debugger.";
  }
  const rows = records.map((record) => [
    String(record.pid),
    record.program,
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

/** The start time `ps` reports for `pid`, as a timestamp, or null when the
 *  process is gone or the date cannot be read. `lstart` is the full date
 *  on both macOS and Linux, such as `Tue Oct 20 13:32:26 2026`. */
export function liveStartTime(pid: number): number | null {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  } catch {
    return null;
  }
  return parseStartTime(output);
}

export function parseStartTime(output: string): number | null {
  const text = output.trim();
  if (text === "") return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

/** The record for `pid`, when its process is the one the record is
 *  about. A run that crashes leaves its record behind, and the operating
 *  system may later give that pid to an unrelated process, which the
 *  attach signal would kill; so the record's start time is checked against
 *  the live process before anything is sent, and a stale record is
 *  removed. */
export function checkedRecord(dir: string, pid: number): AttachRecord | AttachRefusal {
  const record = readRecord(dir, pid);
  if (record === null) {
    return {
      refused: `no Agency program with pid ${pid} is registered for attach (run with no --attach to list them)`,
    };
  }
  const started = liveStartTime(pid);
  if (started === null) {
    removeRecord(dir, pid);
    return { refused: `pid ${pid} is not running; its record was removed` };
  }
  if (Math.abs(started - record.startedAt) > START_TIME_TOLERANCE_MS) {
    removeRecord(dir, pid);
    return {
      refused:
        `pid ${pid} is now a different process than the one that registered ` +
        `(started ${new Date(started).toLocaleString()}, the record says ` +
        `${new Date(record.startedAt).toLocaleString()}); its record was removed`,
    };
  }
  return record;
}

/** Connect to `sock`, retrying while the program opens it. */
function connectWithRetry(sock: string, retryMs: number): Promise<Channel> {
  const deadline = Date.now() + retryMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect(sock);
      socket.once("connect", () => resolve(lineChannel(socket)));
      socket.once("error", (error) => {
        if (Date.now() >= deadline) {
          reject(new Error(`could not connect to ${sock}: ${error.message}`));
          return;
        }
        setTimeout(attempt, CONNECT_RETRY_STEP_MS);
      });
    };
    attempt();
  });
}

export type AttachCommandOptions = {
  pid?: number;
  /** The UI to drive; the terminal UI when absent. A test passes its own. */
  ui?: DebuggerUI;
  /** Where lines for the person go before the UI is up. */
  print?: (line: string) => void;
  retryMs?: number;
};

/** Run `agency debug --attach`. Resolves with the exit code. */
export async function attachCommand(options: AttachCommandOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const host = nodeHost();
  const dir = sessionsDir(host);
  const refusal = ensureSessionsDir(dir);
  if (refusal !== null) {
    print(`Error: ${refusal.refused}`);
    return 1;
  }
  if (options.pid === undefined) {
    const records = listRecords(dir);
    removeStale(dir, records);
    print(formatListing(listRecords(dir), Date.now()));
    return 0;
  }
  const record = checkedRecord(dir, options.pid);
  if ("refused" in record) {
    print(`Error: ${record.refused}`);
    return 1;
  }
  try {
    process.kill(record.pid, ATTACH_SIGNAL);
  } catch (error) {
    print(`Error: could not signal pid ${record.pid}: ${(error as Error).message}`);
    return 1;
  }
  let channel: Channel;
  try {
    channel = await connectWithRetry(
      recordPaths(dir, record.pid).sock,
      options.retryMs ?? CONNECT_RETRY_MS,
    );
  } catch (error) {
    print(`Error: ${(error as Error).message}`);
    return 1;
  }
  const ui = options.ui ?? terminalUI();
  return await new Promise<number>((resolve) => {
    let ended = false;
    const end = (line: string, code: number): void => {
      if (ended) return;
      ended = true;
      ui.destroy();
      print(line);
      resolve(code);
    };
    serveDebuggerIO(channel, ui, {
      hello: (hello) => ui.attachedTo(hello),
      finished: (value) => end(`Program finished. Return value: ${JSON.stringify(value)}`, 0),
      refused: (reason) => end(`Error: ${reason}`, 1),
    });
    channel.onClose(() => end(`Detached from pid ${record.pid}.`, 0));
    ui.onQuit(() => channel.close());
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
