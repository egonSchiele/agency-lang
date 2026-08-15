import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireDatasetLock } from "./lock.js";

let datasetDir: string;
const warnings: string[] = [];

function acquire() {
  return acquireDatasetLock({ datasetDir, reportWarning: (message) => warnings.push(message) });
}

function lockPath(): string {
  return path.join(datasetDir, ".lock");
}

beforeEach(() => {
  datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-lock-"));
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(datasetDir, { recursive: true, force: true });
});

describe("acquireDatasetLock", () => {
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
