import * as fs from "fs";
import * as path from "path";

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
