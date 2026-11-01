import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { show, defaultCommandDeps } from "@/cli/logsSession/commands.js";
import { liveSessions, resolveTarget } from "@/cli/logsSession/target.js";
import type { CommentsStore } from "@/runDirectory/commentsStore.js";

import { liveViewer, queryDeps, queryDir, writeLog } from "./queryFixture.js";
import { logsSearch } from "./search.js";

const options = { json: false, regex: false, caseSensitive: false };

describe("logsSearch", () => {
  let dir: string;
  beforeEach(() => {
    dir = queryDir();
    // loopEvents: the user asks "write a module", then guide and grep run.
    writeLog(dir, "log.jsonl", [
      { traceId: "first-run", minutesAgo: 30 },
      { traceId: "second-run", minutesAgo: 20 },
      { traceId: "third-run", minutesAgo: 10 },
    ]);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("searches the most recent trace by default", async () => {
    const result = await logsSearch(
      { ...options, pattern: "write a module", log: "log.jsonl" },
      queryDeps(dir),
    );
    const lines = result.text.split("\n");
    expect(result.exitCode).toBe(0);
    expect(lines[0]).toBe("log.jsonl · searched 1 trace · 1 row matched · showing 1");
    expect(lines.slice(2)).toEqual([
      "third-run/round:L:0:user",
      "  User turn · write a module",
      "  write a module",
    ]);
  });

  it("--all searches every trace, newest first", async () => {
    const result = await logsSearch(
      { ...options, pattern: "write a module", log: "log.jsonl", all: true },
      queryDeps(dir),
    );
    expect(result.text.split("\n")[0]).toContain("searched 3 traces · 3 rows matched");
    const addresses = result.text.split("\n").filter((line) => line.endsWith(":user"));
    expect(addresses).toEqual([
      "third-run/round:L:0:user",
      "second-run/round:L:0:user",
      "first-run/round:L:0:user",
    ]);
  });

  it("--limit cuts the hits and the footer counts the rest", async () => {
    const result = await logsSearch(
      { ...options, pattern: "write a module", log: "log.jsonl", all: true, limit: "1" },
      queryDeps(dir),
    );
    expect(result.text).toContain("3 rows matched · showing 1");
    expect(result.text).toContain(
      "2 more rows matched. Narrow with --trace, --kind, or a longer pattern, or raise --limit.",
    );
  });

  it.each([
    [{ limit: "0" }, "--limit needs a positive whole number"],
    [{ context: "abc" }, "--context needs a positive whole number"],
    [
      { kind: "tool,interrupt" },
      "--kind takes a comma-separated list of: user, call, tool, hosted, error (not interrupt)",
    ],
    [{ regex: true, pattern: "(" }, "Invalid regular expression"],
  ])("refuses %o", async (bad, reason) => {
    const result = await logsSearch(
      { ...options, pattern: "module", log: "log.jsonl", ...bad },
      queryDeps(dir),
    );
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain(reason);
  });

  it("finding nothing is not a failure", async () => {
    const result = await logsSearch(
      { ...options, pattern: "nowhere-to-be-found", log: "log.jsonl" },
      queryDeps(dir),
    );
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("log.jsonl · searched 1 trace · 0 rows matched\n\nno rows matched");
  });

  it("--json gives the counts and each hit's address, kind, header, and snippet", async () => {
    const result = await logsSearch(
      { ...options, json: true, pattern: "handlers.md", log: "log.jsonl", kind: "tool" },
      queryDeps(dir),
    );
    expect(result.json).toEqual({
      log: `${dir}/log.jsonl`,
      pattern: "handlers.md",
      tracesSearched: 1,
      matched: 1,
      omitted: 0,
      hits: [
        {
          address: "third-run/guide",
          traceId: "third-run",
          rowId: "guide",
          kind: "tool",
          header: expect.stringMatching(/^Tool · agencyGuide/),
          matches: 1,
          snippet: expect.stringContaining("handlers.md"),
        },
      ],
    });
  });

  it("reads the open viewer's log, the same one session show reads", async () => {
    const viewed = writeLog(dir, "runs/today/statelog.jsonl", [
      { traceId: "viewed-run", minutesAgo: 1 },
    ]);
    const record = liveViewer(viewed, "viewed-run");
    const deps = queryDeps(dir, {
      configuredLog: () => "log.jsonl",
      probe: async () => liveSessions([record], () => ""),
    });
    const result = await logsSearch({ ...options, pattern: "write a module" }, deps);
    expect(result.text.split("\n")[0]).toContain("runs/today/statelog.jsonl");
    const address = result.text.split("\n")[2];
    expect(address).toBe("viewed-run/round:L:0:user");

    const target = resolveTarget({ row: address }, [record], {
      ...deps,
      socketPathFor: () => "",
      openStore: (commentsPath) =>
        ({ path: commentsPath, read: () => [] }) as unknown as CommentsStore,
      author: { kind: "agent", id: "claude" },
    });
    expect(target).toMatchObject({ kind: "session", session: { record: { logPath: viewed } } });
    const shown = show(
      target,
      defaultCommandDeps(async () => ({ ok: true }) as never),
    );
    expect(shown.exitCode).toBe(0);
    expect(shown.text).toContain("User turn · write a module");
  });
});
