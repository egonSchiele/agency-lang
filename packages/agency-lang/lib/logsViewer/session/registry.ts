// The sessions directory: one `<pid>.json` and one `<pid>.sock` per running
// viewer, under the agent home. `listRecords` only lists; `probe` says
// whether a record's viewer answers; `removeStale` deletes the records whose
// process is gone. Each is one step, so the CLI's `list` composes them and a
// probe that times out never deletes anything.
import * as fs from "fs";
import * as path from "path";

import type { Host } from "../../host/host.js";
import { agentHomeDir } from "../../runtime/agentHome.js";
import { processState } from "../../runDirectory/lock.js";
import { request } from "./client.js";
import { SESSION_TIMEOUT_MS, type FocusReply } from "./protocol.js";
import { SessionRecordSchema, type SessionRecord } from "./record.js";

const SESSIONS_DIR = "log-sessions";
/** Only files a viewer wrote are ever touched: `<pid>.json` and `<pid>.sock`. */
const RECORD_FILE = /^\d+\.(json|sock)$/;

export function sessionsDir(host: Pick<Host, "settings" | "system">): string {
  return path.join(agentHomeDir(host), SESSIONS_DIR);
}

export function recordPaths(dir: string, pid: number): { json: string; sock: string } {
  return { json: path.join(dir, `${pid}.json`), sock: path.join(dir, `${pid}.sock`) };
}

export function ensureSessionsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeRecord(dir: string, record: SessionRecord): void {
  ensureSessionsDir(dir);
  fs.writeFileSync(recordPaths(dir, record.pid).json, JSON.stringify(record) + "\n");
}

/** Remove one viewer's record and socket. Paths are built here from the
 *  directory and a pid, never taken from outside, so this can only ever
 *  delete files a viewer wrote. */
export function removeRecord(dir: string, pid: number): void {
  const paths = recordPaths(dir, pid);
  for (const file of [paths.json, paths.sock]) {
    if (!RECORD_FILE.test(path.basename(file))) {
      continue;
    }
    fs.rmSync(file, { force: true });
  }
}

export function listRecords(dir: string): SessionRecord[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || !RECORD_FILE.test(name)) {
      continue;
    }
    try {
      const parsed = SessionRecordSchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")),
      );
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        debug(`${path.join(dir, name)}: not a session record: ${parsed.error.message}`);
      }
    } catch (error) {
      debug(`${path.join(dir, name)}: unreadable: ${(error as Error).message}`);
    }
  }
  return records;
}

export type ProbeResult =
  | { state: "live"; focus: FocusReply }
  /** The process is alive but did not answer in time: a viewer suspended
   *  with Ctrl+Z. Kept, never deleted. */
  | { state: "not-responding" }
  /** The process is gone. */
  | { state: "stale" };

export type ProbedRecord = { record: SessionRecord; result: ProbeResult };

export async function probe(
  dir: string,
  record: SessionRecord,
  timeoutMs: number = SESSION_TIMEOUT_MS,
): Promise<ProbeResult> {
  if (processState(record.pid) === "gone") {
    return { state: "stale" };
  }
  try {
    const reply = await request(recordPaths(dir, record.pid).sock, { op: "get" }, timeoutMs);
    if (reply.ok && reply.focus !== undefined) {
      return { state: "live", focus: reply.focus };
    }
    debug(`session ${record.pid}: unexpected reply to get: ${JSON.stringify(reply)}`);
    return { state: "not-responding" };
  } catch (error) {
    // A connect that fails while the pid is alive is a viewer that is not
    // listening (suspended, or still starting). Not stale: its process lives.
    debug(`session ${record.pid}: ${(error as Error).message}`);
    return { state: "not-responding" };
  }
}

export async function probeAll(dir: string, timeoutMs?: number): Promise<ProbedRecord[]> {
  const records = listRecords(dir);
  return Promise.all(
    records.map(async (record) => ({ record, result: await probe(dir, record, timeoutMs) })),
  );
}

/** Delete the records whose process is gone, and nothing else. */
export function removeStale(dir: string, probed: readonly ProbedRecord[]): SessionRecord[] {
  const stale = probed.filter((entry) => entry.result.state === "stale");
  for (const entry of stale) {
    removeRecord(dir, entry.record.pid);
  }
  return stale.map((entry) => entry.record);
}

function debug(message: string): void {
  if (process.env.DEBUG !== undefined && process.env.DEBUG !== "") {
    console.error(`[logs session] ${message}`);
  }
}
