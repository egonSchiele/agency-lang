// The sessions directory, `~/.agency/debug-sessions`: one `<pid>.json` and
// one `<pid>.sock` per running program that registered for attach. Each
// function does one thing, in the style of the logs viewer's session
// registry, and none shares code with it: this directory is checked before
// every use, because whoever can reach the socket can do what the
// program's owner can do.
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

import type { Host } from "../../host/host.js";
import { agencyHomeDir } from "../../runtime/agencyHome.js";
import { processState } from "../../runDirectory/lock.js";

const SESSIONS_DIR = "debug-sessions";
/** Only files a run wrote are ever touched: `<pid>.json` and `<pid>.sock`. */
const RECORD_FILE = /^\d+\.(json|sock)$/;
/** The bits another user could use: group and world. */
const SHARED_BITS = 0o077;

export const AttachRecordSchema = z
  .object({
    pid: z.number().int().positive(),
    /** The program's path, as the process was started with it. */
    program: z.string(),
    /** The first node the process ran. */
    node: z.string(),
    /** `Date.now()` at the process start, from `process.uptime`; the CLI
     *  compares it with what `ps` reports before it signals a pid, so a
     *  stale record never sends a signal to the wrong process. */
    startedAt: z.number(),
  })
  .strict();

export type AttachRecord = z.infer<typeof AttachRecordSchema>;

export function sessionsDir(host: Pick<Host, "settings" | "system">): string {
  return path.join(agencyHomeDir(host), SESSIONS_DIR);
}

export function recordPaths(dir: string, pid: number): { json: string; sock: string } {
  return { json: path.join(dir, `${pid}.json`), sock: path.join(dir, `${pid}.sock`) };
}

/** Why the sessions directory cannot be used. */
export type DirectoryRefusal = { refused: string };

/** The sessions directory, made with mode `0700` when missing, and
 *  refused unless the current user owns it and no group or world bits are
 *  set. The safety argument for attach rests on this check: the socket in
 *  it is also `chmod 0600`, but that happens after `listen`, with a short
 *  window at the umask's mode. The run and the CLI both call this. */
export function ensureSessionsDir(dir: string): DirectoryRefusal | null {
  if (process.platform === "win32") {
    return { refused: "attach needs Unix sockets and file modes, which Windows lacks" };
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { refused: `could not create ${dir}: ${(error as Error).message}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    return { refused: `could not stat ${dir}: ${(error as Error).message}` };
  }
  if (!stat.isDirectory()) {
    return { refused: `${dir} is not a directory` };
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    return { refused: `${dir} is owned by another user (uid ${stat.uid})` };
  }
  if ((stat.mode & SHARED_BITS) !== 0) {
    return {
      refused:
        `${dir} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); ` +
        `run chmod 700 on it`,
    };
  }
  return null;
}

/** Write `<pid>.json`. The path is removed first and the file created
 *  anew (`wx`), so a symlink left at that name is replaced, not followed. */
export function writeRecord(dir: string, record: AttachRecord): void {
  const file = recordPaths(dir, record.pid).json;
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
}

/** Remove one run's record and socket. Paths are built here from the
 *  directory and a pid, never taken from outside, so this can only ever
 *  delete files a run wrote. */
export function removeRecord(dir: string, pid: number): void {
  const paths = recordPaths(dir, pid);
  for (const file of [paths.json, paths.sock]) {
    if (!RECORD_FILE.test(path.basename(file))) {
      continue;
    }
    fs.rmSync(file, { force: true });
  }
}

/** The record in `<pid>.json`, or null when there is none, it is not a
 *  record, or its pid is not the file's: a record is only trusted to say
 *  what its name says, so a hand-edited file cannot point the CLI at
 *  another process. */
export function readRecord(dir: string, pid: number): AttachRecord | null {
  const file = recordPaths(dir, pid).json;
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = AttachRecordSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success || parsed.data.pid !== pid) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function listRecords(dir: string): AttachRecord[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const records: AttachRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || !RECORD_FILE.test(name)) {
      continue;
    }
    const record = readRecord(dir, Number(name.slice(0, -".json".length)));
    if (record !== null) {
      records.push(record);
    }
  }
  return records.sort((a, b) => a.pid - b.pid);
}

/** Delete the records whose process is gone, and nothing else. */
export function removeStale(dir: string, records: readonly AttachRecord[]): AttachRecord[] {
  const stale = records.filter((record) => processState(record.pid) === "gone");
  for (const record of stale) {
    removeRecord(dir, record.pid);
  }
  return stale;
}
