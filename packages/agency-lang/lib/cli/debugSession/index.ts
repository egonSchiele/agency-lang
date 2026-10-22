// `agency debug session …`: find the program, open a visit on its
// socket, run the verb, print, exit. The verbs are in commands.ts, the
// target rules in target.ts, the protocol in visit.ts; this file only
// sequences, and is the one file here with a socket in it.
import * as fs from "fs";
import * as net from "net";

import { nodeHost } from "@/host/node/nodeHost.js";
import { ATTACH_SIGNAL } from "@/runtime/platform.node.js";
import { lineChannel } from "@/debugger/attach/lineChannel.js";
import type { Channel } from "@/debugger/attach/channel.js";
import {
  ensureSessionsDir,
  listRecords,
  recordPaths,
  removeStale,
  sessionsDir,
  type AttachRecord,
} from "@/debugger/attach/registry.js";
import { CONNECT_RETRY_MS, checkedRecord, connectWithRetry } from "../attach.js";

import {
  EXIT,
  answer,
  branch,
  branches,
  checkpoint,
  checkpoints,
  defaultCommandDeps,
  detach,
  edit,
  frame,
  guards,
  moveVerb,
  pause,
  rewind,
  saveOrLoad,
  set,
  source,
  stack,
  thread,
  threads,
  wait,
  where,
  type CommandDeps,
  type CommandResult,
  type SessionCommand,
} from "./commands.js";
import { shownPath } from "./readers.js";
import { resolveTarget, sessionWords, type ProbedProgram } from "./target.js";
import { openVisit, probeStatus, type Visit } from "./visit.js";

export type SessionCliCommand = SessionCommand | { name: "list" } | { name: "attach"; pid: number };

export type SessionCliOptions = { pid?: number; json: boolean };

export type SessionCliDeps = {
  sessionsDir: string;
  cwd: string;
  commandDeps: CommandDeps;
  checked(dir: string, pid: number): AttachRecord | { refused: string };
  /** Send the attach signal to a program whose socket is not open. */
  signal(pid: number): void;
  connect(pid: number, sock: string): Promise<Channel>;
  probeTimeoutMs: number;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
};

const PROBE_TIMEOUT_MS = 1_000;

export function defaultSessionCliDeps(): SessionCliDeps {
  const cwd = process.cwd();
  return {
    sessionsDir: sessionsDir(nodeHost()),
    cwd,
    commandDeps: defaultCommandDeps(cwd),
    checked: checkedRecord,
    signal: (pid) => process.kill(pid, ATTACH_SIGNAL),
    connect: (pid, sock) => connectWithRetry(pid, sock, CONNECT_RETRY_MS),
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

/** Run one command. Resolves with the exit code. */
export async function debugSession(
  command: SessionCliCommand,
  options: SessionCliOptions,
  deps: SessionCliDeps = defaultSessionCliDeps(),
): Promise<number> {
  const refusal = ensureSessionsDir(deps.sessionsDir);
  if (refusal !== null) {
    return print(deps, options, refused(refusal.refused));
  }
  return print(deps, options, await run(command, options, deps));
}

/** Text goes to stdout, a refusal's to stderr. JSON always goes to
 *  stdout, so a program reading it finds the `refused` field where it
 *  reads everything else. */
function print(deps: SessionCliDeps, options: SessionCliOptions, result: CommandResult): number {
  if (options.json) {
    deps.writeStdout(JSON.stringify(result.json, null, 2) + "\n");
    return result.exitCode;
  }
  (result.exitCode === EXIT.refused ? deps.writeStderr : deps.writeStdout)(result.text + "\n");
  return result.exitCode;
}

function refused(text: string): CommandResult {
  return { text, json: { refused: text }, exitCode: EXIT.refused };
}

async function run(
  command: SessionCliCommand,
  options: SessionCliOptions,
  deps: SessionCliDeps,
): Promise<CommandResult> {
  if (command.name === "list") {
    return list(await probeAll(deps), deps);
  }
  if (command.name === "attach") {
    return attach(command.pid, deps);
  }
  const probed = await probeAll(deps);
  const target = resolveTarget(options.pid, probed, (pid) => deps.checked(deps.sessionsDir, pid));
  if (target.kind === "refused") {
    return refused(target.reason);
  }
  // A socket that answers with no session is a program listening for a
  // debugger, not one being debugged: a visit would open a session and
  // stop it, which only `attach` may do.
  const status = probed.find((entry) => entry.record.pid === target.record.pid)?.status ?? null;
  const sock = recordPaths(deps.sessionsDir, target.record.pid).sock;
  if (status === null || (status.cli === null && !status.terminal && !status.finished)) {
    return refused(
      `no session on ${target.record.pid}; \`agency debug session attach ${target.record.pid}\` opens one`,
    );
  }
  return withVisit(target.record, sock, deps, (visit) => verb(command, visit, target.record, deps));
}

/** Every registered program, each probed for its session state. */
async function probeAll(deps: SessionCliDeps): Promise<ProbedProgram[]> {
  const records = listRecords(deps.sessionsDir);
  removeStale(deps.sessionsDir, records);
  const live = listRecords(deps.sessionsDir);
  return Promise.all(
    live.map(async (record) => {
      const sock = recordPaths(deps.sessionsDir, record.pid).sock;
      if (!fs.existsSync(sock)) {
        return { record, status: null };
      }
      const socket = net.connect(sock);
      const connected = await new Promise<boolean>((resolve) => {
        socket.once("connect", () => resolve(true));
        socket.once("error", () => resolve(false));
      });
      if (!connected) {
        return { record, status: null };
      }
      return { record, status: await probeStatus(lineChannel(socket), deps.probeTimeoutMs) };
    }),
  );
}

export function listText(probed: readonly ProbedProgram[], now: number, cwd: string): string {
  if (probed.length === 0) {
    return "No Agency programs are registered for attach.";
  }
  const rows = probed.map((entry) => [
    String(entry.record.pid),
    shownPath(entry.record.program, cwd),
    entry.record.node,
    `${Math.max(0, Math.round((now - entry.record.startedAt) / 1000))}s ago`,
    sessionWords(entry.status, now),
  ]);
  const header = ["PID", "PROGRAM", "NODE", "STARTED", "SESSION"];
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

function list(probed: ProbedProgram[], deps: SessionCliDeps): CommandResult {
  return {
    text: listText(probed, Date.now(), deps.cwd),
    json: probed.map((entry) => ({ ...entry.record, session: entry.status })),
    exitCode: EXIT.ok,
  };
}

async function attach(pid: number, deps: SessionCliDeps): Promise<CommandResult> {
  const record = deps.checked(deps.sessionsDir, pid);
  if ("refused" in record) {
    return refused(record.refused);
  }
  const sock = recordPaths(deps.sessionsDir, pid).sock;
  if (!fs.existsSync(sock)) {
    try {
      deps.signal(pid);
    } catch (error) {
      return refused(`could not signal pid ${pid}: ${(error as Error).message}`);
    }
  }
  return withVisit(record, sock, deps, async (visit) => {
    // A fresh session stops at the program's next statement; the visit
    // waits for that stop so the summary is of the stop, not of the
    // moment before it.
    if (visit.pending === null && visit.finished === null) {
      const next = await visit.next(deps.commandDeps.moveWaitMs);
      if (next.kind === "request") {
        return where(
          {
            ...visit,
            pending: next.request,
            shown: next.shown,
            recent: [...visit.recent, ...next.recent],
          },
          record,
          deps.commandDeps,
        );
      }
      if (next.kind === "finished") {
        return where({ ...visit, finished: next.finished }, record, deps.commandDeps);
      }
    }
    return where(visit, record, deps.commandDeps);
  });
}

async function withVisit(
  record: AttachRecord,
  sock: string,
  deps: SessionCliDeps,
  body: (visit: Visit) => Promise<CommandResult> | CommandResult,
): Promise<CommandResult> {
  const opened = await openVisitWithRetry(record, sock, deps);
  if ("refused" in opened) {
    return refused(opened.refused);
  }
  const { channel, visit } = opened;
  try {
    return await body(visit);
  } finally {
    visit.close();
  }
}

/** How long a command keeps trying to join while the run still counts
 *  the command before it as connected. The run learns a visit is over
 *  from its socket closing, which lands a moment after that process
 *  exits, so a script running commands back to back can arrive first. */
export const VISIT_RETRY_MS = 1_000;
const VISIT_RETRY_STEP_MS = 50;
const EARLIER_VISIT = "another visit is in progress";

async function openVisitWithRetry(
  record: AttachRecord,
  sock: string,
  deps: SessionCliDeps,
): Promise<{ channel: Channel; visit: Visit } | { refused: string }> {
  const deadline = Date.now() + VISIT_RETRY_MS;
  while (true) {
    let channel: Channel;
    try {
      channel = await deps.connect(record.pid, sock);
    } catch (error) {
      return { refused: (error as Error).message };
    }
    const visit = await openVisit(channel);
    if (!("refused" in visit)) {
      return { channel, visit };
    }
    channel.close();
    if (visit.refused !== EARLIER_VISIT || Date.now() >= deadline) {
      return visit;
    }
    await new Promise((resolve) => setTimeout(resolve, VISIT_RETRY_STEP_MS));
  }
}

async function verb(
  command: SessionCommand,
  visit: Visit,
  record: AttachRecord,
  deps: SessionCliDeps,
): Promise<CommandResult> {
  const commandDeps = deps.commandDeps;
  switch (command.name) {
    case "where":
      return where(visit, record, commandDeps);
    case "frame":
      return frame(visit, record, command.index, command.globals);
    case "stack":
      return stack(visit, record);
    case "threads":
      return threads(visit, record);
    case "thread":
      return thread(visit, record, command.label, command.last);
    case "branches":
      return branches(visit, record);
    case "branch":
      return branch(visit, record, command.key);
    case "guards":
      return guards(visit, record);
    case "source":
      return source(visit, record, command.context, commandDeps);
    case "checkpoints":
      return checkpoints(visit, record, commandDeps);
    case "step":
    case "next":
    case "in":
    case "out":
    case "continue":
    case "back":
      return moveVerb(visit, record, command.name, commandDeps);
    case "wait":
      return wait(visit, record, command.forMs, commandDeps);
    case "pause":
      return pause(visit, record);
    case "rewind":
      return rewind(visit, record, command.id, commandDeps);
    case "set":
      return set(visit, record, command.varName, command.value, commandDeps);
    case "edit":
      return edit(visit, record, command, commandDeps);
    case "checkpoint":
      return checkpoint(visit, record, command.label, commandDeps);
    case "save":
    case "load":
      return saveOrLoad(visit, record, command.name, command.path, commandDeps);
    case "answer":
      return answer(visit, record, command.value, commandDeps);
    case "detach":
      return detach(visit, record);
  }
}
