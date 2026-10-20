import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listRecords,
  probe,
  recordPaths,
  removeStale,
  sessionsDir,
  writeRecord,
} from "./registry.js";
import type { SessionRecord } from "./record.js";

function record(pid: number): SessionRecord {
  return { pid, logPath: "/logs/run.jsonl", cwd: "/", started: "2026-10-19T14:28:40Z" };
}

describe("the session registry", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists every record, including one whose socket is gone, and skips other files", () => {
    writeRecord(dir, record(1));
    writeRecord(dir, record(2));
    fs.writeFileSync(path.join(dir, "notes.json"), "{}");
    fs.writeFileSync(path.join(dir, "3.json"), "not json");
    expect(listRecords(dir).map((entry) => entry.pid)).toEqual([1, 2]);
  });

  it("tells a dead process from a live one that does not answer, and deletes only the dead", async () => {
    // A pid that cannot be running: the max pid on every platform is far lower.
    const dead = record(2_000_000_000);
    writeRecord(dir, dead);
    // Our own pid is alive but has no socket at that path: not responding.
    const silent = record(process.pid);
    writeRecord(dir, silent);
    expect(await probe(dir, dead, 100)).toEqual({ state: "stale" });
    expect(await probe(dir, silent, 100)).toEqual({ state: "not-responding" });

    const probed = [
      { record: dead, result: await probe(dir, dead, 100) },
      { record: silent, result: await probe(dir, silent, 100) },
    ];
    const removed = removeStale(dir, probed);
    expect(removed.map((entry) => entry.pid)).toEqual([dead.pid]);
    expect(fs.existsSync(recordPaths(dir, dead.pid).json)).toBe(false);
    expect(fs.existsSync(recordPaths(dir, silent.pid).json)).toBe(true);
  });

  it("lives under the agent home", () => {
    const host = {
      settings: { read: () => "/tmp/agent-home" },
      system: { cwd: () => "/", homeDir: () => "/Users/x" },
    };
    expect(sessionsDir(host as never)).toBe(path.join("/tmp/agent-home", "log-sessions"));
  });
});
