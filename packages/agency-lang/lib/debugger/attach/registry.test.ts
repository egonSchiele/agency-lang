import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { memoryHost } from "@/host/memoryHost.js";
import {
  ensureSessionsDir,
  listRecords,
  readRecord,
  recordPaths,
  removeRecord,
  removeStale,
  sessionsDir,
  writeRecord,
  type AttachRecord,
} from "./registry.js";

const record = (pid: number): AttachRecord => ({
  pid,
  program: "/work/agent.agency",
  node: "main",
  startedAt: 1_700_000_000_000,
});

describe("the sessions directory", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("is debug-sessions under AGENCY_HOME, else under ~/.agency", () => {
    const withHome = memoryHost({ variables: { AGENCY_HOME: "/elsewhere" } });
    expect(sessionsDir(withHome)).toBe(path.join("/elsewhere", "debug-sessions"));
    const plain = memoryHost();
    expect(sessionsDir(plain)).toBe(path.join(plain.system.homeDir(), ".agency", "debug-sessions"));
  });

  it("is created with mode 700 and then accepted", () => {
    const dir = path.join(home, "debug-sessions");
    expect(ensureSessionsDir(dir)).toBeNull();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(ensureSessionsDir(dir)).toBeNull();
  });

  it("is refused when other users can read it", () => {
    const dir = path.join(home, "debug-sessions");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const refusal = ensureSessionsDir(dir);
    expect(refusal).not.toBeNull();
    expect(refusal!.refused).toContain("readable by other users");
    expect(refusal!.refused).toContain("chmod 700");
  });

  it("is refused when it is a file", () => {
    const dir = path.join(home, "debug-sessions");
    fs.writeFileSync(dir, "");
    expect(ensureSessionsDir(dir)?.refused).toContain("could not create");
  });
});

describe("records", () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-")), "debug-sessions");
    ensureSessionsDir(dir);
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("round-trip, with mode 600, and are removed with their socket", () => {
    writeRecord(dir, record(4242));
    expect(fs.statSync(recordPaths(dir, 4242).json).mode & 0o777).toBe(0o600);
    expect(readRecord(dir, 4242)).toEqual(record(4242));
    fs.writeFileSync(recordPaths(dir, 4242).sock, "");
    removeRecord(dir, 4242);
    expect(readRecord(dir, 4242)).toBeNull();
    expect(fs.existsSync(recordPaths(dir, 4242).sock)).toBe(false);
  });

  it("a record whose pid is not its file name is ignored", () => {
    fs.writeFileSync(recordPaths(dir, 123).json, JSON.stringify(record(456)));
    expect(readRecord(dir, 123)).toBeNull();
    expect(listRecords(dir)).toEqual([]);
  });

  it("a symlink at the record path is replaced, not followed", () => {
    const elsewhere = path.join(path.dirname(dir), "elsewhere.json");
    fs.writeFileSync(elsewhere, "untouched");
    fs.symlinkSync(elsewhere, recordPaths(dir, 4242).json);
    writeRecord(dir, record(4242));
    expect(fs.lstatSync(recordPaths(dir, 4242).json).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(readRecord(dir, 4242)).toEqual(record(4242));
  });

  it("are listed in pid order, ignoring files a run did not write", () => {
    writeRecord(dir, record(20));
    writeRecord(dir, record(3));
    fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify(record(99)));
    fs.writeFileSync(path.join(dir, "7.json"), "not json");
    expect(listRecords(dir).map((entry) => entry.pid)).toEqual([3, 20]);
  });

  it("removeStale deletes only the records whose process is gone", () => {
    writeRecord(dir, record(process.pid));
    // A pid no process has: the largest the kernel allows is far below this.
    const gone = 2_000_000_000;
    writeRecord(dir, record(gone));
    const stale = removeStale(dir, listRecords(dir));
    expect(stale.map((entry) => entry.pid)).toEqual([gone]);
    expect(readRecord(dir, process.pid)).not.toBeNull();
    expect(readRecord(dir, gone)).toBeNull();
  });
});
