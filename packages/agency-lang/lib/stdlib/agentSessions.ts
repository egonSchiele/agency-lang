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

const INDEX_FILE = "index.json";

function checkpointFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/** The index rows, most recently saved first. An unreadable or malformed
 *  index reads as empty. */
export function _listSessions(dir: string): SessionRecord[] {
  const file = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SessionRecord => typeof r === "object" && r !== null && typeof r.id === "string",
    );
  } catch {
    return [];
  }
}

/** Write the checkpoint file, then the index with `record` first. Returns
 *  "" on success, else the error message. */
export function _saveSession(dir: string, record: SessionRecord, checkpoint: unknown): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(checkpointFile(dir, record.id), JSON.stringify(checkpoint));
    const others = _listSessions(dir).filter((r) => r.id !== record.id);
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify([record, ...others]));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The parsed checkpoint, or null when the file is missing or malformed. */
export function _readCheckpointFile(dir: string, id: string): unknown {
  const file = checkpointFile(dir, id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
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
