import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pathKind } from "@/cli/logsSession/index.js";
import { show, defaultCommandDeps } from "@/cli/logsSession/commands.js";
import { liveSessions, resolveTarget, type LiveSession } from "@/cli/logsSession/target.js";
import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import type { CommentsStore } from "@/runDirectory/commentsStore.js";
import { readTraces } from "@/runDirectory/traces.js";

import { cliLoadLog, type CliLogDeps } from "./cliLog.js";
import { queryDeps, queryDir, writeLog } from "./queryFixture.js";
import { logsSearch } from "./search.js";
import type { QueryDeps } from "./shared.js";
import { logsTraces } from "./traces.js";

/** A probed viewer that answers, open on `logPath` at `traceId`. */
function liveViewer(logPath: string, traceId: string): ProbedRecord {
  return {
    record: { pid: 7, logPath, cwd: path.dirname(logPath), started: "" },
    result: {
      state: "live",
      focus: { traceId, screen: "trace", rowId: undefined, logPath, commentsPath: undefined },
    },
  };
}

/** The CLI's way of choosing a log over the files in `cwd`: no viewer
 *  open and no config unless `overrides` say so. */
function cliLogDeps(cwd: string, overrides: Partial<CliLogDeps> = {}): CliLogDeps {
  return {
    cwd,
    pathKind,
    childRunDirectories: () => [],
    configuredLog: () => undefined,
    probe: async (): Promise<LiveSession[]> => [],
    readLog: (logPath) => readTraces(logPath).traces,
    ...overrides,
  };
}

function cliQueryDeps(cwd: string, overrides: Partial<CliLogDeps> = {}): QueryDeps {
  return queryDeps(cwd, { loadLog: cliLoadLog(cliLogDeps(cwd, overrides)) });
}

const flags = { json: false, errors: false };

describe("cliLoadLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = queryDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("with no --log, reads the configured log", async () => {
    writeLog(dir, "configured.jsonl", [{ traceId: "from-config", minutesAgo: 1 }]);
    const result = await logsTraces(
      flags,
      cliQueryDeps(dir, { configuredLog: () => "configured.jsonl" }),
    );
    expect(result.text.split("\n")[0]).toContain("configured.jsonl");
    expect(result.text).toContain("from-config");
  });

  it("the one open viewer's log wins over the configured log", async () => {
    writeLog(dir, "log.jsonl", [{ traceId: "from-config", minutesAgo: 1 }]);
    const viewed = writeLog(dir, "runs/today/statelog.jsonl", [
      { traceId: "from-viewer", minutesAgo: 1 },
    ]);
    const record = liveViewer(viewed, "from-viewer");
    const deps = cliQueryDeps(dir, {
      configuredLog: () => "log.jsonl",
      probe: async () => liveSessions([record], () => ""),
    });
    const result = await logsTraces(flags, deps);
    expect(result.text.split("\n")[0]).toContain(path.join("runs", "today", "statelog.jsonl"));
    expect(result.text).toContain("from-viewer");
  });

  it("with no log anywhere, refuses with the three ways forward", async () => {
    const result = await logsTraces(flags, cliQueryDeps(dir));
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("No log given");
  });

  it("search reads the open viewer's log, the same one session show reads", async () => {
    const viewed = writeLog(dir, "runs/today/statelog.jsonl", [
      { traceId: "viewed-run", minutesAgo: 1 },
    ]);
    const record = liveViewer(viewed, "viewed-run");
    const logDeps = cliLogDeps(dir, {
      configuredLog: () => "log.jsonl",
      probe: async () => liveSessions([record], () => ""),
    });
    const result = await logsSearch(
      { json: false, regex: false, caseSensitive: false, pattern: "write a module" },
      queryDeps(dir, { loadLog: cliLoadLog(logDeps) }),
    );
    expect(result.text.split("\n")[0]).toContain("runs/today/statelog.jsonl");
    const address = result.text.split("\n")[2];
    expect(address).toBe("viewed-run/round:L:0:user");

    const target = resolveTarget({ row: address }, [record], {
      ...logDeps,
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
