import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  _isCheckpoint,
  _listSessions,
  _recordRunFormat,
  _saveSession,
  _searchSessions,
  _readCheckpointFile,
  _readTranscript,
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

describe("what a record's run file holds", () => {
  it("is what the record says", () => {
    expect(_recordRunFormat({ ...record("a", 1), runFormat: "savedRun" })).toBe("savedRun");
    expect(_recordRunFormat({ ...record("a", 1), runFormat: "checkpoint" })).toBe("checkpoint");
  });

  it("is a checkpoint when the record does not say", () => {
    expect(_recordRunFormat(record("a", 1))).toBe("checkpoint");
  });

  // Perry's records from before it ran the agent's program.
  it("is a saved run for an old Perry record", () => {
    expect(_recordRunFormat({ ...record("a", 1), brain: "perry" })).toBe("savedRun");
  });

  it("skips a record whose format is not one of the two", () =>
    withDir(async (base) => {
      const dir = path.join(base, "sessions");
      await _saveSession(dir, record("good", 10), {});
      fs.writeFileSync(
        path.join(dir, "bad.meta.json"),
        JSON.stringify({ ...record("bad", 20), runFormat: "something else" }),
      );
      expect((await _listSessions(dir)).map((r) => r.id)).toEqual(["good"]);
    }));
});

describe("reading a saved conversation", () => {
  // The smallest checkpoint the schema accepts, whose one frame holds
  // thread "3".
  const saved = {
    id: 1,
    nodeId: "main",
    globals: { store: {}, initializedModules: [] },
    stack: {
      stack: [
        {
          args: {},
          locals: {},
          step: 0,
          threads: {
            counter: 4,
            activeStack: ["3"],
            threads: {
              "3": {
                messages: [
                  { role: "system", content: "You are an agent." },
                  { role: "user", content: "hello" },
                  { role: "assistant", content: "hi there" },
                ],
              },
            },
          },
        },
      ],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    },
  };

  it("reads the user and assistant messages of the thread the id names", () => {
    expect(_readTranscript(saved, "t3")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  // The check the terminal makes before it restores a file.
  it("tells a checkpoint from another front-end's saved run", () => {
    expect(_isCheckpoint(saved)).toBe(true);
    expect(_isCheckpoint({ version: 1, pause: [{ checkpoint: saved }] })).toBe(false);
    expect(_isCheckpoint(null)).toBe(false);
  });

  it("returns nothing for an unknown id or an empty one", () => {
    expect(_readTranscript(saved, "t9")).toEqual([]);
    expect(_readTranscript(saved, "")).toEqual([]);
  });

  // A search covers the sessions of both front-ends, since both save into
  // one folder. A saved run holds its checkpoint inside its pause.
  it("searches a saved run as well as a checkpoint", () =>
    withDir(async (base) => {
      const dir = path.join(base, "sessions");
      await _saveSession(dir, { ...record("terminal", 10), conversationThread: "t3" }, saved);
      await _saveSession(
        dir,
        { ...record("app", 20), conversationThread: "t3", runFormat: "savedRun" as const },
        { version: 1, pause: [{ checkpoint: saved }], cancelledTexts: [], turn: null },
      );
      // A saved run with nothing readable in it gives no hits and no error.
      await _saveSession(
        dir,
        { ...record("empty", 30), conversationThread: "t3", runFormat: "savedRun" as const },
        { version: 1, pause: [] },
      );
      const hits = await _searchSessions(dir, "hello", "", 10);
      expect(hits.map((hit) => hit.sessionId).sort()).toEqual(["app", "terminal"]);
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
