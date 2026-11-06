import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  _listSessions,
  _saveSession,
  _readCheckpointFile,
  matchingMessages,
  queryWords,
  type TranscriptMessage,
} from "./agentSessions.js";
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

describe("session search", () => {
  const said = (role: "user" | "assistant", content: string): TranscriptMessage => ({
    role,
    content,
  });

  it("splits a query into lower-cased words", () => {
    expect(queryWords("  Grep   FLAGS ")).toEqual(["grep", "flags"]);
  });

  it("matches a message that holds every word, in any case and order", () => {
    const messages = [
      said("user", "What did we decide about the grep flags?"),
      said("assistant", "The Flags for GREP are a rule table."),
      said("user", "And the grep path?"),
    ];
    const contents = matchingMessages(messages, ["grep", "flags"]).map((m) => m.content);
    expect(contents).toEqual([
      "The Flags for GREP are a rule table.",
      "What did we decide about the grep flags?",
    ]);
  });

  it("matches nothing for an empty query", () => {
    expect(matchingMessages([said("user", "anything")], [])).toEqual([]);
  });

  it("cuts a long message to the text around the first word", () => {
    const long = `${"a".repeat(500)} needle ${"b".repeat(500)}`;
    const [match] = matchingMessages([said("assistant", long)], ["needle"]);
    expect(match.content.startsWith("…")).toBe(true);
    expect(match.content.endsWith("…")).toBe(true);
    expect(match.content).toContain(" needle ");
    expect(match.content.length).toBeLessThan(420);
  });
});
