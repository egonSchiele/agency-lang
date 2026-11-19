import { currentRun, type Run } from "../runtime/asyncContext.js";
import type { MessageJSON } from "smoltalk";
import type { Host, Root } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { __call } from "../runtime/call.js";
import { hasInterrupts } from "../runtime/interrupts.js";
import { checkpointFor, getCheckpointFor } from "../runtime/checkpoint.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { stripSlug } from "../runtime/runner.js";
import { _contentToString } from "./threads.js";
import { printAgentTrace } from "./agentToolTrace.js";

/**
 * File I/O for the agency agent's saved sessions
 * (`lib/agents/agency-agent/lib/sessions.agency`). Plain filesystem work
 * under the agent's own state directory, like the REPL history file in
 * `cli.ts`: it is harness bookkeeping, not a tool, so it raises no
 * interrupt and is never handed to a model.
 *
 * Each session is two files, `<id>.json` (the run) and
 * `<id>.meta.json` (the record). The record's `runFormat` says what the
 * run file holds, so nobody has to open one to find out. There is no shared index: two agents in
 * the same directory would race on one, and a listing is cheap to derive.
 */

/**
 * What a session's run file holds.
 *
 * - `checkpoint`: one checkpoint, taken between turns. `agency agent`
 *   writes this, and resumes it with `restore`.
 * - `savedRun`: the interrupts a session core paused on, each with its
 *   checkpoint, as a front-end that drives the core from outside saves it
 *   (`{ version, pause, cancelledTexts, turn }`). Perry writes this.
 *
 * Both programs save into the same folders, and neither can resume the
 * other's file yet.
 */
export type RunFormat = "checkpoint" | "savedRun";

const RUN_FORMATS: string[] = ["checkpoint", "savedRun"];

// The brain Perry gave its records before it ran the agent's own program.
// They carry no `runFormat`, and their run files are saved runs.
const OLD_PERRY_BRAIN = "perry";

export type SessionRecord = {
  id: string;
  cwd: string;
  brain: string;
  created: number;
  lastActive: number;
  turns: number;
  title: string;
  /** The id of the session this one was forked from, when it is a fork. */
  forkedFrom?: string;
  /** The slug id of the thread the conversation runs on, such as "t3". */
  conversationThread?: string;
  /** What the run file holds. A record without it is a checkpoint. */
  runFormat?: RunFormat;
};

/** What a record's run file holds. A record that does not say is a
 *  checkpoint: every record was, before the field existed. */
export function _recordRunFormat(record: SessionRecord): RunFormat {
  if (record.runFormat != null) return record.runFormat;
  return record.brain === OLD_PERRY_BRAIN ? "savedRun" : "checkpoint";
}

const META_SUFFIX = ".meta.json";

function checkpointFile(id: string): string {
  return `${id}.json`;
}

function metaFile(id: string): string {
  return `${id}${META_SUFFIX}`;
}

/** The parsed JSON of `name` under `dir`, or null when it is missing or
 *  malformed. */
async function readJson(host: Host, dir: Root, name: string): Promise<unknown> {
  try {
    if ((await host.files.stat(dir, name)) === null) return null;
    return JSON.parse(await host.files.readText(dir, name));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const isText = (k: string) => typeof r[k] === "string";
  const isCount = (k: string) => typeof r[k] === "number" && Number.isFinite(r[k]) && r[k] >= 0;
  // Agency writes a field that was never set as null.
  const forkIsValid = r.forkedFrom == null || isText("forkedFrom");
  const threadIsValid = r.conversationThread == null || isText("conversationThread");
  const formatIsValid =
    r.runFormat == null || (typeof r.runFormat === "string" && RUN_FORMATS.includes(r.runFormat));
  return (
    forkIsValid &&
    threadIsValid &&
    formatIsValid &&
    isText("id") &&
    isText("cwd") &&
    isText("brain") &&
    isText("title") &&
    isCount("created") &&
    isCount("lastActive") &&
    isCount("turns")
  );
}

/** Every session in `dir`, most recently active first, whatever its run
 *  file holds. A malformed record file is skipped. */
export async function _listSessions(dir: string): Promise<SessionRecord[]> {
  const host = currentHost();
  const sessions = await host.files.root(dir);
  if ((await host.files.stat(sessions, ".")) === null) return [];
  const records: SessionRecord[] = [];
  for (const entry of await host.files.list(sessions, ".")) {
    if (entry.type !== "file" || !entry.name.endsWith(META_SUFFIX)) continue;
    const parsed = await readJson(host, sessions, entry.name);
    if (isRecord(parsed)) records.push(parsed);
  }
  records.sort((a, b) => b.lastActive - a.lastActive);
  return records;
}

/** Write the checkpoint, then the record. Returns "" on success, else the
 *  error message. */
export async function _saveSession(
  dir: string,
  record: SessionRecord,
  checkpoint: unknown,
): Promise<string> {
  const host = currentHost();
  return saveSession(host, dir, record, checkpoint);
}

async function saveSession(
  host: Host,
  dir: string,
  record: SessionRecord,
  checkpoint: unknown,
): Promise<string> {
  try {
    const sessions = await host.files.root(dir);
    await host.files.mkdir(sessions, ".");
    // writeText renames a finished sibling over the target, so a crash
    // mid-write never leaves a half-written file.
    await host.files.writeText(sessions, checkpointFile(record.id), JSON.stringify(checkpoint));
    await host.files.writeText(sessions, metaFile(record.id), JSON.stringify(record));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The parsed checkpoint, or null when the file is missing or malformed. */
export async function _readCheckpointFile(dir: string, id: string): Promise<unknown> {
  const host = currentHost();
  return readJson(host, await host.files.root(dir), checkpointFile(id));
}

export type TranscriptMessage = { role: "user" | "assistant"; content: string };

type ThreadJSON = {
  messages: { role?: string; content?: unknown }[];
};

/**
 * The user and assistant messages of a saved session's conversation
 * thread, named by its slug id. Tool calls and results are left out.
 */
export function _readTranscript(checkpointJson: unknown, threadId: string): TranscriptMessage[] {
  const cp = Checkpoint.fromJSON(checkpointJson);
  if (!cp || threadId === "") {
    return [];
  }
  const thread = savedThread(cp, threadId);
  if (!thread) {
    return [];
  }
  const out: TranscriptMessage[] = [];
  for (const m of thread.messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    const text = _contentToString(m.content as MessageJSON["content"]);
    if (text !== "") {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

// Every frame on the saved stack carries the thread store; the outermost
// frame's copy is the one the REPL was waiting in.
function savedThread(cp: Checkpoint, threadId: string): ThreadJSON | null {
  const rawId = stripSlug(threadId);
  for (const frame of cp.stack.stack ?? []) {
    const thread = frame.threads?.threads[rawId];
    if (thread) {
      return thread as ThreadJSON;
    }
  }
  return null;
}

/** One message of a saved session that matched a search. */
export type SessionHit = {
  sessionId: string;
  title: string;
  /** When the session was last used, in milliseconds since the Unix epoch. */
  lastActive: number;
  role: "user" | "assistant";
  snippet: string;
};

// A search reads this many of the most recent sessions. Each one is a whole
// checkpoint file, so an old project's every session is too much to read.
const MAX_SESSIONS_SEARCHED = 50;

// The most hits one session gives, so one long session cannot fill the list.
const MAX_HITS_PER_SESSION = 3;

// Characters shown on each side of the first matched word.
const SNIPPET_RADIUS = 200;

/** The words of a query, lower-cased. A message matches when it holds every
 *  one of them, in any order and any letter case. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
}

/** The text around the first place `word` appears in `text`, with `…` on a
 *  side that was cut. */
function snippetAround(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + word.length + SNIPPET_RADIUS);
  const before = start > 0 ? "…" : "";
  const after = end < text.length ? "…" : "";
  return `${before}${text.slice(start, end)}${after}`;
}

/** The messages that hold every word, newest first, as snippets. */
export function matchingMessages(
  messages: TranscriptMessage[],
  words: string[],
): TranscriptMessage[] {
  if (words.length === 0) {
    return [];
  }
  const holdsEveryWord = (message: TranscriptMessage) => {
    const text = message.content.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return messages
    .filter(holdsEveryWord)
    .reverse()
    .map((message) => ({ role: message.role, content: snippetAround(message.content, words[0]) }));
}

/**
 * Search the conversations of the sessions saved in `dir` for messages
 * that hold every word of `query`. Sessions are read most recent first,
 * and `skipId` (the running session) is left out. Returns at most `limit`
 * hits.
 */
export async function _searchSessions(
  dir: string,
  query: string,
  skipId: string,
  limit: number,
): Promise<SessionHit[]> {
  const words = queryWords(query);
  const records = (await _listSessions(dir)).filter((record) => record.id !== skipId);
  const hits: SessionHit[] = [];
  for (const record of records.slice(0, MAX_SESSIONS_SEARCHED)) {
    if (hits.length >= limit) {
      break;
    }
    const transcript = _readTranscript(
      checkpointIn(record, await _readCheckpointFile(dir, record.id)),
      record.conversationThread ?? "",
    );
    const matches = matchingMessages(transcript, words).slice(0, MAX_HITS_PER_SESSION);
    hits.push(
      ...matches.map((match) => ({
        sessionId: record.id,
        title: record.title,
        lastActive: record.lastActive,
        role: match.role,
        snippet: match.content,
      })),
    );
  }
  return hits.slice(0, limit);
}

// The checkpoint to read a session's conversation from. A saved run holds
// one in each interrupt it paused on, and they all carry the conversation.
function checkpointIn(record: SessionRecord, runFile: unknown): unknown {
  if (_recordRunFormat(record) === "checkpoint") return runFile;
  if (typeof runFile !== "object" || runFile === null) return null;
  const pause: unknown = (runFile as Record<string, unknown>).pause;
  if (!Array.isArray(pause) || typeof pause[0] !== "object" || pause[0] === null) return null;
  return (pause[0] as Record<string, unknown>).checkpoint ?? null;
}

type SaveTarget = { dir: string; record: SessionRecord } | null;

// The Agency callbacks the REPL turn wraps. Installed from `main()` before
// any restore, and held here rather than passed through Agency code: a
// closure built by an Agency statement would be in the checkpoint as a
// completed step, and come back from a restore as nothing.
let hooks: { onSubmit: unknown; afterTurn: unknown } | null = null;

export function _installSessionHooks(onSubmit: unknown, afterTurn: unknown): void {
  hooks = { onSubmit, afterTurn };
}

function call(run: Run, fn: unknown, ...args: unknown[]): Promise<unknown> {
  return __call(run, fn, { type: "positional", args });
}

/**
 * The REPL's `onSubmit` for a saved session. After a turn, once its Agency
 * frames have returned, the stack is "REPL waiting at the prompt"; that is
 * the state checkpointed and written. (A checkpoint taken inside the turn
 * would carry the turn's own frame, and on resume the runtime would hand
 * that frame to the next `onSubmit` call.)
 */
export async function _sessionOnSubmit(line: string): Promise<unknown> {
  const run = currentRun();
  if (!hooks) throw new Error("_installSessionHooks was not called");
  const reply = await call(run, hooks.onSubmit, line);
  // A turn stopped by an interrupt did not finish, so there is nothing to
  // record; the REPL shows the interrupt.
  if (reply === false || hasInterrupts(reply)) return reply;
  const target = (await call(run, hooks.afterTurn, line)) as SaveTarget;
  if (target) {
    const cp = getCheckpointFor(run, await checkpointFor(run));
    const error = await saveSession(run.ctx.host, target.dir, target.record, cp);
    if (error) {
      printAgentTrace(run.ctx.host, { kind: "sessionSaveFailure", message: error });
    } else {
      reportHerdrSession(target.record.id);
    }
  }
  return reply;
}

/** Tell Herdr which session the pane holds and how to reopen it after a
 *  Herdr restart, through the hook the line-mode REPL installs. Herdr runs
 *  the command in the pane's directory, which is the directory the session
 *  is saved under. */
function reportHerdrSession(id: string): void {
  const hook = (globalThis as any).__agencyHerdrSession;
  if (typeof hook === "function") {
    hook({ id, resumeArgv: ["agency", "agent", "--resume", id] });
  }
}
