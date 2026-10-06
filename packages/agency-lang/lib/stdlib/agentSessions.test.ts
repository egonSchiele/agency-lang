import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { _listSessions, _saveSession, _readCheckpointFile } from "./agentSessions.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".sessions-test-"));
  try {
    await fn(dir);
  } finally {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
  }
}

const record = (id: string, lastActive: number) => ({
  id,
  cwd: "/work",
  brain: "coordinator",
  created: 1,
  lastActive,
  turns: 2,
  title: `session ${id}`,
});

describe("saved sessions", () => {
  it("saves, lists most recent first, and reads the checkpoint back", () =>
    withDir(async (base) => {
      const dir = path.join(base, "sessions");
      expect(await _saveSession(dir, record("a", 10), { step: 1 })).toBe("");
      expect(await _saveSession(dir, record("b", 20), { step: 2 })).toBe("");
      expect((await _listSessions(dir)).map((r) => r.id)).toEqual(["b", "a"]);
      expect(await _readCheckpointFile(dir, "a")).toEqual({ step: 1 });
      expect(await _readCheckpointFile(dir, "missing")).toBeNull();
    }));

  it("hides a symlinked record and refuses to read a symlinked checkpoint", () =>
    withDir(async (base) => {
      const dir = path.join(base, "sessions");
      const outside = path.join(base, "outside");
      fs.mkdirSync(outside);
      await _saveSession(outside, record("x", 5), { secret: true });
      fs.mkdirSync(dir);
      fs.symlinkSync(path.join(outside, "x.meta.json"), path.join(dir, "x.meta.json"));
      fs.symlinkSync(path.join(outside, "x.json"), path.join(dir, "x.json"));
      expect(await _listSessions(dir)).toEqual([]);
      expect(await _readCheckpointFile(dir, "x")).toBeNull();
    }));
});
