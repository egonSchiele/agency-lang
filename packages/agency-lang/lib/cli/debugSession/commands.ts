// The verbs of `agency debug session`, each a function of a joined
// `Visit`, its arguments, and the record of the program, returning the
// text and JSON to print and an exit code. No verb touches a flag, a
// socket, or the registry; `index.ts` opens the visit and prints. The
// readers are pure functions of the checkpoint the visit was shown
// (`readers.ts`), and a moving verb answers the pending request and
// prints `where` at the stop that follows.
import { editsFor, listEdits, listingText, viewOf, type EditRequest } from "./editVerb.js";
import type { AttachRecord } from "@/debugger/attach/registry.js";
import { checkpointFromWire } from "@/debugger/attach/serveIO.js";
import { REPLY_SCHEMAS, type RequestMessage } from "@/debugger/attach/protocol.js";
import type { DebuggerCommand } from "@/debugger/types.js";
import type { Checkpoint } from "@/runtime/state/checkpointStore.js";
import type { DebugStopData } from "@/runtime/debugger.js";

import {
  frameAt,
  lineFor,
  readSourceMap,
  shownPath,
  sourceAround,
  sourcePathFor,
  stackOf,
  type FrameView,
} from "./readers.js";
import type { Next, Shown, Visit } from "./visit.js";
import { guardWords, runningText, whereJson, whereText, type WhereInput } from "./where.js";

export type CommandResult = { text: string; json: unknown; exitCode: number };

/** 0 an answer, 1 a refusal, 2 the program ended, 3 `wait` ran out. */
export const EXIT = { ok: 0, refused: 1, ended: 2, stillRunning: 3 } as const;

export type CommandDeps = {
  cwd: string;
  readSourceMap: typeof readSourceMap;
  sourcePathFor: typeof sourcePathFor;
  sourceAround: typeof sourceAround;
  /** How long a moving verb waits for the next stop before saying the
   *  program is running. */
  moveWaitMs: number;
};

export const defaultCommandDeps = (cwd: string): CommandDeps => ({
  cwd,
  readSourceMap,
  sourcePathFor,
  sourceAround,
  moveWaitMs: 30_000,
});

export type SessionCommand =
  | { name: "where" }
  | { name: "frame"; index?: number; globals: boolean }
  | { name: "stack" }
  | { name: "threads" }
  | { name: "thread"; label?: string; last: number }
  | { name: "branches" }
  | { name: "branch"; key: string }
  | { name: "guards" }
  | { name: "source"; context: number }
  | { name: "checkpoints" }
  | { name: "step" }
  | { name: "next" }
  | { name: "in" }
  | { name: "out" }
  | { name: "continue" }
  | { name: "wait"; forMs: number }
  | { name: "pause" }
  | { name: "back" }
  | { name: "rewind"; id: number }
  | { name: "set"; varName: string; value: unknown }
  | { name: "checkpoint"; label?: string }
  | { name: "save"; path: string }
  | { name: "load"; path: string }
  | { name: "answer"; value: unknown }
  | ({ name: "edit" } & EditRequest)
  | { name: "detach" };

function refused(text: string): CommandResult {
  return { text, json: { refused: text }, exitCode: EXIT.refused };
}

function ok(text: string, json: unknown): CommandResult {
  return { text, json, exitCode: EXIT.ok };
}

/** The stop the visit was shown, or the refusal when the program is
 *  running or the visit has no render yet. */
function shownStop(visit: Visit, record: AttachRecord): { shown: Shown } | CommandResult {
  if (visit.pending === null) {
    return {
      text: runningText(record.program, record.pid, visit.parties),
      json: { pid: record.pid, program: record.program, stopped: false },
      exitCode: EXIT.ok,
    };
  }
  if (visit.shown?.checkpoint === undefined) {
    return refused("the program is stopped but sent no state to show; try again");
  }
  return { shown: visit.shown };
}

function whereInput(
  visit: Visit,
  record: AttachRecord,
  shown: Shown,
  recent: string[],
  deps: CommandDeps,
): WhereInput {
  const stop = shown.stop;
  const line = stop === undefined ? undefined : lineFor(deps.readSourceMap(record.program), stop);
  let statement: string | undefined;
  if (stop !== undefined && line !== undefined) {
    const sourcePath = deps.sourcePathFor(stop.moduleId, deps.cwd, record.program);
    const window = sourcePath === null ? null : deps.sourceAround(sourcePath, line, 0);
    statement = window?.lines[0];
  }
  return {
    program: shownPath(record.program, deps.cwd),
    node: record.node,
    pid: record.pid,
    parties: visit.parties,
    recent,
    edits: visit.queuedEdits.applied,
    checkpoint: shown.checkpoint,
    stop,
    line,
    statement,
    interruptId: shown.interruptId,
  };
}

export function where(visit: Visit, record: AttachRecord, deps: CommandDeps): CommandResult {
  if (visit.finished !== null) {
    return finishedResult(visit.finished);
  }
  const at = shownStop(visit, record);
  if (!("shown" in at)) {
    return at;
  }
  const input = whereInput(visit, record, at.shown, visit.recent, deps);
  return ok(whereText(input), whereJson(input));
}

function finishedResult(finished: { value?: unknown; error?: string }): CommandResult {
  const text =
    finished.error === undefined
      ? `Program finished. Return value: ${JSON.stringify(finished.value)}`
      : `Program threw: ${finished.error}`;
  return {
    text,
    json: { finished: true, value: finished.value, error: finished.error },
    exitCode: EXIT.ended,
  };
}

/** A reader: a function of the checkpoint and the stop, on the stop the
 *  visit was shown. */
function read(
  visit: Visit,
  record: AttachRecord,
  body: (checkpoint: Checkpoint, stop: DebugStopData | undefined) => CommandResult,
): CommandResult {
  if (visit.finished !== null) {
    return finishedResult(visit.finished);
  }
  const at = shownStop(visit, record);
  if (!("shown" in at)) {
    return at;
  }
  return body(at.shown.checkpoint!, at.shown.stop);
}

function cut(value: unknown, limit = 400): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} characters)` : text;
}

function frameText(frame: FrameView, globals: Record<string, unknown> | null): string {
  const lines = [`#${frame.index} ${frame.name} · ${frame.moduleId}`];
  if (frame.loop !== undefined) {
    const removed =
      frame.loop.removedTools.length === 0 ? "" : `; removed ${frame.loop.removedTools.join(", ")}`;
    lines.push(`  round ${frame.loop.round}${removed}`);
  }
  for (const [name, value] of Object.entries(frame.args)) {
    lines.push(`  arg ${name} = ${cut(value)}`);
  }
  for (const [name, value] of Object.entries(frame.locals)) {
    lines.push(`  ${name} = ${cut(value)}`);
  }
  if (globals !== null) {
    for (const [name, value] of Object.entries(globals)) {
      lines.push(`  global ${name} = ${cut(value)}`);
    }
  }
  return lines.join("\n");
}

export function frame(
  visit: Visit,
  record: AttachRecord,
  index: number | undefined,
  globals: boolean,
): CommandResult {
  return read(visit, record, (checkpoint, stop) => frameResult(checkpoint, stop, index, globals));
}

function frameResult(
  checkpoint: Checkpoint,
  stop: DebugStopData | undefined,
  index: number | undefined,
  globals: boolean,
): CommandResult {
  {
    const found = frameAt(checkpoint, stop, index);
    if (found === null) {
      return refused(`no frame ${index}; \`stack\` numbers them`);
    }
    const moduleGlobals = globals
      ? (checkpoint.globalsAt(stop?.branchPath ?? []).store?.[found.moduleId] ?? {})
      : null;
    return ok(frameText(found, moduleGlobals), { ...found, globals: moduleGlobals });
  }
}

export function stack(visit: Visit, record: AttachRecord): CommandResult {
  return read(visit, record, (checkpoint, stop) => {
    const frames = stackOf(checkpoint, stop?.branchPath ?? []);
    const text = frames
      .map((frame) => {
        const loop =
          frame.loop === undefined
            ? ""
            : ` (round ${frame.loop.round}${frame.loop.removedTools.length === 0 ? "" : `; removed ${frame.loop.removedTools.join(", ")}`})`;
        return `#${frame.index} ${frame.name}${loop} · ${frame.moduleId}`;
      })
      .join("\n");
    return ok(text, frames);
  });
}

export function threads(visit: Visit, record: AttachRecord): CommandResult {
  return read(visit, record, (checkpoint, stop) => {
    const all = checkpoint.listThreads(stop?.branchPath ?? []);
    const text = all
      .map(
        (thread) =>
          `${thread.label ?? thread.id}${thread.parentId === null ? "" : ` (under ${thread.parentId})`} · ${thread.messageCount} messages${thread.active ? " · active" : ""}`,
      )
      .join("\n");
    return ok(text === "" ? "no threads" : text, all);
  });
}

export function thread(
  visit: Visit,
  record: AttachRecord,
  label: string | undefined,
  last: number,
): CommandResult {
  return read(visit, record, (checkpoint, stop) => {
    const branchPath = stop?.branchPath ?? [];
    const all = checkpoint.listThreads(branchPath);
    const chosen =
      label === undefined
        ? all.find((thread) => thread.active)
        : all.find((thread) => thread.label === label || thread.id === label);
    if (chosen === undefined) {
      const names = all.map((thread) => thread.label ?? thread.id).join(", ");
      return refused(
        label === undefined ? "no active thread" : `no thread "${label}"; the threads are ${names}`,
      );
    }
    const messages = checkpoint.getThreadMessages(chosen.id, branchPath);
    if (messages === null) {
      return refused(`thread "${label ?? chosen.id}" has no messages to show`);
    }
    const shown = messages.messages.slice(-last);
    const skipped = messages.messages.length - shown.length;
    const lines = shown.map((message) => `[${message.role}] ${cut(message.content, 600)}`);
    const head =
      skipped > 0
        ? [`(${skipped} earlier messages not shown; --last ${messages.messages.length} shows all)`]
        : [];
    return ok([...head, ...lines].join("\n"), { ...messages, messages: shown, skipped });
  });
}

export function branches(visit: Visit, record: AttachRecord): CommandResult {
  return read(visit, record, (checkpoint) => {
    const all = checkpoint.listBranches();
    const text = all
      .map((branch) => `${branch.key} · ${branch.label} · ${branch.status} · under ${branch.owner}`)
      .join("\n");
    return ok(text === "" ? "no branches" : text, all);
  });
}

export function branch(visit: Visit, record: AttachRecord, key: string): CommandResult {
  return read(visit, record, (checkpoint) => {
    const found = checkpoint.listBranches().find((candidate) => candidate.key === key);
    if (found === undefined) {
      return refused(`no branch "${key}"; \`branches\` lists them`);
    }
    const frames = stackOf(checkpoint, found.path);
    const text = [
      `${found.key} · ${found.label} · ${found.status} · under ${found.owner}`,
      ...frames.map((frame) => `#${frame.index} ${frame.name} · ${frame.moduleId}`),
    ].join("\n");
    return ok(text, { ...found, stack: frames });
  });
}

export function guards(visit: Visit, record: AttachRecord): CommandResult {
  return read(visit, record, (checkpoint, stop) => {
    const branchPath = stop?.branchPath ?? [];
    const all = checkpoint.listGuards(branchPath);
    const loop = checkpoint.loopState(branchPath);
    const lines = all.map((guard) => guardWords(guard));
    if (loop !== null) {
      lines.unshift(
        `tool loop · round ${loop.round}${loop.removedTools.length === 0 ? "" : ` · removed ${loop.removedTools.join(", ")}`}`,
      );
    }
    return ok(lines.length === 0 ? "no guards" : lines.join("\n"), { guards: all, loop });
  });
}

export function source(
  visit: Visit,
  record: AttachRecord,
  context: number,
  deps: CommandDeps,
): CommandResult {
  return read(visit, record, (_checkpoint, stop) => {
    if (stop === undefined) {
      return refused("the stop has no location");
    }
    const line = lineFor(deps.readSourceMap(record.program), stop);
    if (line === undefined) {
      return refused(
        `no source line for ${stop.moduleId} ${stop.scopeName}: the compiled program at ${record.program} has no map for it from here`,
      );
    }
    const sourcePath = deps.sourcePathFor(stop.moduleId, deps.cwd, record.program);
    const window = sourcePath === null ? null : deps.sourceAround(sourcePath, line, context);
    if (window === null) {
      return refused(
        `${stop.moduleId}:${line}; the source is not at ${stop.moduleId} from here; run from the program's directory to see it`,
      );
    }
    const text = window.lines
      .map((text, offset) => {
        const number = window.first + offset;
        return `${number === line ? ">" : " "} ${String(number).padStart(4)}  ${text}`;
      })
      .join("\n");
    return ok(text, { path: window.path, line, first: window.first, lines: window.lines });
  });
}

/** The command a moving verb answers the stop with. */
const MOVES: Record<string, DebuggerCommand> = {
  step: { type: "step" },
  next: { type: "next" },
  in: { type: "stepIn" },
  out: { type: "stepOut" },
  continue: { type: "continue" },
  back: { type: "stepBack" },
};

/** How long `continue` waits after its reply for the run to refuse it
 *  (another party answered the stop first) before reporting the program
 *  running. The refusal comes with the reply's round trip; a stop may
 *  not come for an hour. */
export const ANSWER_GRACE_MS = 300;

/** The lines the driver logs when a command it was given could not be
 *  done: the stop that follows is the same stop, not a success. */
const FAILURE_LINES = [
  /^Already at earliest checkpoint/,
  /^No checkpoint on current interrupt/,
  /^Current checkpoint is not valid for stepping back/,
  /^No checkpoints available for rewind/,
  /^Checkpoint #\d+ not found/,
  /^No checkpoint to save/,
  /^Failed to (save|load):/,
  /^Invalid checkpoint data/,
  /^refused: /,
];

/** The driver's line saying the command was not done, if one came. */
function failureLine(recent: string[]): string | null {
  return recent.find((line) => FAILURE_LINES.some((pattern) => pattern.test(line))) ?? null;
}

/** Answer the stop the visit was shown with `command` and wait for what
 *  follows, or the refusal when the stop cannot take a command: the
 *  program is running, has ended, or waits on a question `answer`
 *  takes instead. */
async function answerStop(
  visit: Visit,
  record: AttachRecord,
  command: DebuggerCommand,
  waitMs: number,
): Promise<Next | CommandResult> {
  if (visit.finished !== null) {
    return finishedResult(visit.finished);
  }
  if (visit.pending === null) {
    return refused(`${record.program} is running; \`wait\` stops here at its next stop`);
  }
  if (visit.pending.method !== "waitForCommand") {
    return refused(
      `the program is waiting on ${visit.pending.method}, which this command cannot answer; \`answer <json>\` replies to it, \`where\` says more, \`detach\` leaves it`,
    );
  }
  return visit.answer(command, waitMs);
}

/** Answer the pending request with `command` and report what followed:
 *  `where` at the next stop, the refusal when another party answered
 *  first, the program's end, or that it is running. */
export async function move(
  visit: Visit,
  record: AttachRecord,
  command: DebuggerCommand,
  deps: CommandDeps,
  waitMs: number,
): Promise<CommandResult> {
  const next = await answerStop(visit, record, command, waitMs);
  return "kind" in next ? afterMove(visit, record, next, deps) : next;
}

function afterMove(
  visit: Visit,
  record: AttachRecord,
  next: Next,
  deps: CommandDeps,
): CommandResult {
  switch (next.kind) {
    case "request": {
      const failed = failureLine(next.recent);
      if (failed !== null) {
        return refused(failed);
      }
      if (next.shown?.checkpoint === undefined) {
        return refused("the program stopped but sent no state to show; try `where`");
      }
      const input = whereInput(visit, record, next.shown, next.recent, deps);
      return ok(whereText(input), whereJson(input));
    }
    case "answered":
      return refused(
        `the stop you saw was answered by the ${next.answered.by} (${next.answered.command}); run \`where\` and decide again`,
      );
    case "finished":
      return finishedResult(next.finished);
    case "closed":
      return {
        text: "the connection closed; the program may have exited",
        json: { closed: true },
        exitCode: EXIT.ended,
      };
    case "timeout":
      return ok(runningText(record.program, record.pid, visit.parties), {
        pid: record.pid,
        program: record.program,
        stopped: false,
      });
  }
}

export async function moveVerb(
  visit: Visit,
  record: AttachRecord,
  name: "step" | "next" | "in" | "out" | "continue" | "back",
  deps: CommandDeps,
): Promise<CommandResult> {
  // `continue` does not wait for a stop: the program may run for an hour.
  const waitMs = name === "continue" ? ANSWER_GRACE_MS : deps.moveWaitMs;
  return move(visit, record, MOVES[name]!, deps, waitMs);
}

/** Reply to the question the program is waiting on, a guard trip, a
 *  node's arguments, or `input()`, with `value` as the answer. The run
 *  checks the answer's shape for the question and drops the visit on a
 *  wrong one, so the shape is checked here first. */
export async function answer(
  visit: Visit,
  record: AttachRecord,
  value: unknown,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (visit.finished !== null) {
    return finishedResult(visit.finished);
  }
  if (visit.pending === null) {
    return refused(`${record.program} is running and waiting on no question`);
  }
  const method = visit.pending.method;
  if (method === "waitForCommand") {
    return refused(
      "the program is stopped at a statement, not a question; `step` and the other moves answer that",
    );
  }
  if (method === "render" || method === "showRewindSelector" || method === "showCheckpointsPanel") {
    return refused(
      `the program is waiting on ${method}, which \`rewind\` and \`checkpoints\` handle`,
    );
  }
  const checked = REPLY_SCHEMAS[method].safeParse(value);
  if (!checked.success) {
    return refused(`${cut(value)} is not a ${method} answer: ${ANSWER_SHAPES[method]}`);
  }
  return afterMove(visit, record, await visit.answer(checked.data, deps.moveWaitMs), deps);
}

/** What `answer` takes for each question, for the refusal. */
const ANSWER_SHAPES = {
  answerGuardTrip: '{"type":"approve"} or {"type":"reject","value":"why"}',
  promptForNodeArgs: "a JSON array, one value per parameter",
  promptForInput: "a JSON string",
} as const;

export async function wait(
  visit: Visit,
  record: AttachRecord,
  forMs: number,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (visit.finished !== null) {
    return finishedResult(visit.finished);
  }
  if (visit.pending !== null) {
    return where(visit, record, deps);
  }
  const next = await visit.next(forMs);
  if (next.kind === "timeout") {
    return {
      text: `${record.program} is still running after ${Math.round(forMs / 1000)}s`,
      json: { pid: record.pid, program: record.program, stopped: false, waited: forMs },
      exitCode: EXIT.stillRunning,
    };
  }
  return afterMove(visit, record, next, deps);
}

export function pause(visit: Visit, record: AttachRecord): CommandResult {
  if (visit.finished !== null) {
    return finishedResult(visit.finished);
  }
  if (visit.pending !== null) {
    return ok(`${record.program} is already stopped; \`where\` shows the stop`, { pausing: false });
  }
  visit.pause();
  return ok("pausing at the next statement; `wait` returns at that stop", { pausing: true });
}

/** A command the driver answers by redrawing the same stop (`set`,
 *  `checkpoint`): the stop that follows is the one before, with what the
 *  command changed, or the driver's line saying it could not be done. */
async function sameStop(
  visit: Visit,
  record: AttachRecord,
  command: DebuggerCommand,
  deps: CommandDeps,
): Promise<{ shown: Shown; recent: string[] } | CommandResult> {
  const next = await answerStop(visit, record, command, deps.moveWaitMs);
  if (!("kind" in next)) {
    return next;
  }
  const result = afterMove(visit, record, next, deps);
  if (result.exitCode !== EXIT.ok || next.kind !== "request") {
    return result;
  }
  return { shown: next.shown!, recent: next.recent };
}

/** `edit`: with no action, the edits this stop takes; with one, queue it
 *  and print the driver's line for what it will change; `--drop` clears
 *  the queue. The rows and flags come from the debugger's action table,
 *  so an agent sees the edits a person sees on the pane rows. */
export async function edit(
  visit: Visit,
  record: AttachRecord,
  request: EditRequest,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (request.drop) {
    const at = await sameStop(visit, record, { type: "dropEdits" }, deps);
    if (!("shown" in at)) return at;
    return ok(at.recent.join("\n") || "no edits were pending", { dropped: true });
  }
  if (visit.shown === null || visit.pending === null) {
    return refused("the program is not stopped; `wait` stops here at its next stop");
  }
  const view = viewOf(visit.shown, visit.queuedEdits);
  if (view === null) {
    return refused("the stop sent no state to edit; try `where`");
  }
  if (request.action === undefined) {
    const listing = listEdits(view);
    return ok(listingText(listing), { edits: listing });
  }
  const made = editsFor(request, view);
  if ("refused" in made) return refused(made.refused);
  const at = await sameStop(visit, record, { type: "edit", edits: made.edits }, deps);
  if (!("shown" in at)) return at;
  const applied = at.recent.filter((line) => !line.startsWith("Stopped"));
  return ok(applied.join("\n") || "queued", { edits: made.edits, applied });
}

export async function set(
  visit: Visit,
  record: AttachRecord,
  varName: string,
  value: unknown,
  deps: CommandDeps,
): Promise<CommandResult> {
  const at = await sameStop(visit, record, { type: "set", varName, value }, deps);
  if (!("shown" in at)) {
    return at;
  }
  // The frame is read from the stop the set redrew, not from the one
  // the visit joined at; the `Visit` fields are what it was shown then.
  const after = frameResult(at.shown.checkpoint!, at.shown.stop, undefined, false);
  return ok(`queued ${varName} = ${cut(value)} for the next resume\n${after.text}`, {
    set: { varName, value },
    frame: after.json,
  });
}

export async function checkpoint(
  visit: Visit,
  record: AttachRecord,
  label: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  const at = await sameStop(visit, record, { type: "checkpoint", label }, deps);
  if (!("shown" in at)) {
    return at;
  }
  return ok(`pinned a checkpoint${label === undefined ? "" : ` "${label}"`}`, {
    pinned: label ?? null,
  });
}

export async function saveOrLoad(
  visit: Visit,
  record: AttachRecord,
  name: "save" | "load",
  filePath: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  return move(visit, record, { type: name, path: filePath }, deps, deps.moveWaitMs);
}

type CheckpointRow = { id: number; scope: string; moduleId: string; stepPath: string };

function checkpointRows(checkpoints: Checkpoint[]): CheckpointRow[] {
  return checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    scope: checkpoint.scopeName,
    moduleId: checkpoint.moduleId,
    stepPath: checkpoint.stepPath,
  }));
}

/** The rolling window and the pinned checkpoints: the stop is answered
 *  with `showCheckpoints`, the driver asks the visit to show the panel,
 *  and the visit prints the list instead and closes the panel. */
export async function checkpoints(
  visit: Visit,
  record: AttachRecord,
  deps: CommandDeps,
): Promise<CommandResult> {
  const asked = await askForPanel(
    visit,
    record,
    { type: "showCheckpoints" },
    "showCheckpointsPanel",
    deps,
  );
  if ("result" in asked) {
    return asked.result;
  }
  const rows = checkpointRows(checkpointsFromArgs(asked.request));
  const current = visit.shown?.checkpoint?.id;
  const text = rows
    .map(
      (row) =>
        `${row.id === current ? ">" : " "} #${row.id} ${row.scope} · ${row.moduleId} · step ${row.stepPath}`,
    )
    .join("\n");
  await visit.reply(asked.request.id, undefined, 0);
  return ok(text === "" ? "no checkpoints" : text, rows);
}

/** Rewind to the checkpoint with `id`: the stop is answered with
 *  `rewind`, the driver asks the visit to pick one, and the visit picks
 *  by id. */
export async function rewind(
  visit: Visit,
  record: AttachRecord,
  id: number,
  deps: CommandDeps,
): Promise<CommandResult> {
  const asked = await askForPanel(visit, record, { type: "rewind" }, "showRewindSelector", deps);
  if ("result" in asked) {
    return asked.result;
  }
  const rows = checkpointRows(checkpointsFromArgs(asked.request));
  if (!rows.some((row) => row.id === id)) {
    await visit.reply(asked.request.id, null, 0);
    return refused(`no checkpoint #${id}; \`checkpoints\` lists them`);
  }
  // The picker answers with the checkpoint's id, which is what the
  // driver looks the checkpoint up by.
  return afterMove(visit, record, await visit.reply(asked.request.id, id, deps.moveWaitMs), deps);
}

function checkpointsFromArgs(request: RequestMessage): Checkpoint[] {
  const wire = request.args[0];
  if (!Array.isArray(wire)) {
    return [];
  }
  return wire.map(checkpointFromWire).filter((cp): cp is Checkpoint => cp !== undefined);
}

/** Answer the stop with `command` and wait for the driver's `method`
 *  request, which carries the checkpoints a panel shows. */
async function askForPanel(
  visit: Visit,
  record: AttachRecord,
  command: DebuggerCommand,
  method: "showCheckpointsPanel" | "showRewindSelector",
  deps: CommandDeps,
): Promise<{ request: RequestMessage } | { result: CommandResult }> {
  const next = await answerStop(visit, record, command, deps.moveWaitMs);
  if (!("kind" in next)) {
    return { result: next };
  }
  if (next.kind === "request" && next.request.method === method) {
    return { request: next.request };
  }
  if (next.kind === "request") {
    return {
      result: refused(`the program asked for ${next.request.method} instead; run \`where\``),
    };
  }
  return { result: afterMove(visit, record, next, deps) };
}

/** Leave the session: the CLI's hold is released. With no terminal
 *  attached the program runs on with no debugger; with one, the
 *  terminal keeps driving, and the program stays where it is. */
export function detach(visit: Visit, record: AttachRecord): CommandResult {
  visit.detach();
  const terminal = visit.parties.terminal;
  const what = terminal
    ? "the terminal debugger stays on it and the program waits for it"
    : "it runs on with no debugger";
  return ok(`detached from ${record.program} (pid ${record.pid}); ${what}`, {
    detached: true,
    terminal,
  });
}
