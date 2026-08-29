import * as fs from "fs";
import * as path from "path";
import { __call } from "../runtime/call.js";
import { checkpoint, getCheckpoint } from "../runtime/checkpoint.js";

/**
 * File I/O for the agency agent's saved sessions
 * (`lib/agents/agency-agent/lib/sessions.agency`). Plain filesystem work
 * under the agent's own state directory, like the REPL history file in
 * `cli.ts`: it is harness bookkeeping, not a tool, so it raises no
 * interrupt and is never handed to a model.
 *
 * Each session is two files, `<id>.json` (the checkpoint) and
 * `<id>.meta.json` (the record). There is no shared index: two agents in
 * the same directory would race on one, and a listing is cheap to derive.
 */

export type SessionRecord = {
  id: string;
  cwd: string;
  brain: string;
  created: number;
  lastActive: number;
  turns: number;
  title: string;
};

const META_SUFFIX = ".meta.json";

function checkpointFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function metaFile(dir: string, id: string): string {
  return path.join(dir, `${id}${META_SUFFIX}`);
}

/** Write via a sibling temp file and rename, so a crash mid-write never
 *  leaves a half-written file (the same pattern as the REPL history). */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is SessionRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionRecord).id === "string" &&
    typeof (value as SessionRecord).lastActive === "number"
  );
}

/** Every session in `dir`, most recently active first. A malformed
 *  record file is skipped. */
export function _listSessions(dir: string): SessionRecord[] {
  if (!fs.existsSync(dir)) return [];
  const records: SessionRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(META_SUFFIX)) continue;
    const parsed = readJson(path.join(dir, name));
    if (isRecord(parsed)) records.push(parsed);
  }
  records.sort((a, b) => b.lastActive - a.lastActive);
  return records;
}

/** Write the checkpoint, then the record. Returns "" on success, else the
 *  error message. */
export function _saveSession(dir: string, record: SessionRecord, checkpoint: unknown): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(checkpointFile(dir, record.id), JSON.stringify(checkpoint));
    writeAtomic(metaFile(dir, record.id), JSON.stringify(record));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The parsed checkpoint, or null when the file is missing or malformed. */
export function _readCheckpointFile(dir: string, id: string): unknown {
  return readJson(checkpointFile(dir, id));
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

function call(fn: unknown, ...args: unknown[]): Promise<unknown> {
  return __call(fn, { type: "positional", args });
}

/**
 * The REPL's `onSubmit` for a saved session. After a turn, once its Agency
 * frames have returned, the stack is "REPL waiting at the prompt"; that is
 * the state checkpointed and written. (A checkpoint taken inside the turn
 * would carry the turn's own frame, and on resume the runtime would hand
 * that frame to the next `onSubmit` call.)
 */
export async function _sessionOnSubmit(line: string): Promise<unknown> {
  if (!hooks) throw new Error("_installSessionHooks was not called");
  const reply = await call(hooks.onSubmit, line);
  if (reply === false) return reply;
  const target = (await call(hooks.afterTurn, line)) as SaveTarget;
  if (target) {
    const cp = getCheckpoint(await checkpoint());
    const error = _saveSession(target.dir, target.record, cp);
    if (error) process.stdout.write(`Could not save this session: ${error}\n`);
  }
  return reply;
}
