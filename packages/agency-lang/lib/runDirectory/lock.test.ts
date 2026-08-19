import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireOwnedFileLock, acquireRunDirLock } from "./lock.js";

let dir: string;
const warnings: string[] = [];

function acquire() {
  return acquireRunDirLock({ dir: dir, reportWarning: (message) => warnings.push(message) });
}

function lockPath(): string {
  return path.join(dir, ".lock");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-dir-lock-"));
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("acquireRunDirLock", () => {
  it("creates the lock file and reports the holder", () => {
    const lock = acquire();
    expect(lock.holder.pid).toBe(process.pid);
    expect(fs.existsSync(lockPath())).toBe(true);
    lock.release();
  });

  it("excludes a second holder", () => {
    const lock = acquire();
    expect(() => acquire()).toThrow(new RegExp(String(process.pid)));
    lock.release();
  });

  it("does NOT take over a lock whose process is gone, and says what to do", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 999999,
        token: "someone-else",
        acquiredAt: "2026-08-03T00:00:00.000Z",
      }),
    );
    expect(() => acquire()).toThrow(/no longer running.*delete/is);
  });

  it("reports an unreadable lock rather than silently replacing it", () => {
    fs.writeFileSync(lockPath(), "not json");
    expect(() => acquire()).toThrow(/unreadable/i);
  });

  it("can be re-acquired after release", () => {
    acquire().release();
    const second = acquire();
    expect(fs.existsSync(lockPath())).toBe(true);
    second.release();
  });

  it("removes the lock on release", () => {
    acquire().release();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("is idempotent on repeated release", () => {
    const lock = acquire();
    lock.release();
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("does not remove a lock another session now owns", () => {
    const lock = acquire();
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 4242,
        token: "different-token",
        acquiredAt: "2026-08-03T00:00:00.000Z",
      }),
    );
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(warnings.join(" ")).toMatch(/not releasing/i);
  });

  it("warns, and does not remove, a lock that is present but unreadable", () => {
    const lock = acquire();
    fs.writeFileSync(lockPath(), "{ not json");
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(warnings.join(" ")).toMatch(/unreadable/i);
  });

  it("tolerates the lock already being gone", () => {
    const lock = acquire();
    fs.rmSync(lockPath());
    expect(() => lock.release()).not.toThrow();
  });

  it("removes its exit listener on release, so sessions do not accumulate", () => {
    const before = process.listenerCount("exit");
    const lock = acquire();
    lock.release();
    expect(process.listenerCount("exit")).toBe(before);
  });
});

describe("acquireOwnedFileLock", () => {
  it("locks exactly the named file, creating its directory, and removes only that file", () => {
    const file = path.join(dir, "checklists", "cl_x", "drafts", "s.lock");
    const lock = acquireOwnedFileLock({ lockFile: file, reportWarning: () => {} });
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(path.join(path.dirname(file), "s.json"), "{}");
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(file), "s.json"))).toBe(true);
    lock.release(); // idempotent
  });

  it("two paths are two independent locks; the same path excludes a second holder", () => {
    const a = path.join(dir, "a.lock");
    const b = path.join(dir, "b.lock");
    const first = acquireOwnedFileLock({ lockFile: a, reportWarning: () => {} });
    expect(() => acquireOwnedFileLock({ lockFile: b, reportWarning: () => {} })).not.toThrow();
    expect(() => acquireOwnedFileLock({ lockFile: a, reportWarning: () => {} })).toThrow(
      /Another writer holds/,
    );
    first.release();
    expect(() => acquireOwnedFileLock({ lockFile: a, reportWarning: () => {} })).not.toThrow();
  });

  it("removes its exit listener on release", () => {
    const before = process.listenerCount("exit");
    const lock = acquireOwnedFileLock({
      lockFile: path.join(dir, "x.lock"),
      reportWarning: () => {},
    });
    expect(process.listenerCount("exit")).toBe(before + 1);
    lock.release();
    expect(process.listenerCount("exit")).toBe(before);
  });
});
