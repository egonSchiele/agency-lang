import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { liveSessions } from "@/cli/logsSession/target.js";

import { liveViewer, queryDeps, queryDir, writeLog, type FixtureTrace } from "./queryFixture.js";
import { DEFAULT_TRACES_SHOWN, logsTraces } from "./traces.js";

const flags = { json: false, errors: false };

describe("logsTraces", () => {
  let dir: string;
  beforeEach(() => {
    dir = queryDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists the traces newest first, under a line naming the file", async () => {
    writeLog(dir, "log.jsonl", [
      { traceId: "old-trace", minutesAgo: 90 },
      { traceId: "new-trace", minutesAgo: 5, error: true },
    ]);
    const result = await logsTraces({ ...flags, log: "log.jsonl" }, queryDeps(dir));
    const lines = result.text.split("\n");
    expect(result.exitCode).toBe(0);
    expect(lines[0]).toBe("log.jsonl · 2 traces · showing 2, newest first");
    expect(lines[3]).toMatch(/^new-trace .* 3 calls .* error {2}"write a module"$/);
    expect(lines[4]).toMatch(/^old-trace /);
    expect(lines[4]).not.toContain("error");
  });

  it("shows the default count and says how many older traces were left out", async () => {
    const many: FixtureTrace[] = Array.from({ length: DEFAULT_TRACES_SHOWN + 3 }, (_, n) => ({
      traceId: `trace-${String(n).padStart(2, "0")}`,
      minutesAgo: n,
    }));
    writeLog(dir, "log.jsonl", many);
    const result = await logsTraces({ ...flags, log: "log.jsonl" }, queryDeps(dir));
    expect(result.text).toContain(`showing ${DEFAULT_TRACES_SHOWN}, newest first`);
    expect(result.text).toContain("3 older traces. Pass --all to list them");
    expect(result.text).toContain("trace-00");
    expect(result.text).not.toContain("trace-22");

    const all = await logsTraces({ ...flags, log: "log.jsonl", all: true }, queryDeps(dir));
    expect(all.text).toContain("trace-22");
    expect(all.text).not.toContain("older trace");
  });

  it("--errors keeps the traces that logged an error", async () => {
    writeLog(dir, "log.jsonl", [
      { traceId: "fine", minutesAgo: 1 },
      { traceId: "broken", minutesAgo: 2, error: true },
    ]);
    const result = await logsTraces({ ...flags, log: "log.jsonl", errors: true }, queryDeps(dir));
    expect(result.text.split("\n")[0]).toBe(
      "log.jsonl · 2 traces · 1 with an error · showing 1, newest first",
    );
    expect(result.text).toContain("broken");
    expect(result.text).not.toContain("fine");
  });

  it("--json gives one record per trace with ISO times", async () => {
    const logPath = writeLog(dir, "log.jsonl", [{ traceId: "only", minutesAgo: 10, error: true }]);
    const result = await logsTraces({ ...flags, json: true, log: "log.jsonl" }, queryDeps(dir));
    expect(result.json).toEqual({
      log: logPath,
      total: 1,
      older: 0,
      traces: [
        {
          traceId: "only",
          startedAt: "2026-10-31T11:50:00.000Z",
          workingMs: expect.any(Number),
          costUsd: 0,
          tokens: 0,
          calls: 3,
          agentName: null,
          hasError: true,
          ask: "write a module",
        },
      ],
    });
  });

  it("with no --log, reads the configured log", async () => {
    writeLog(dir, "configured.jsonl", [{ traceId: "from-config", minutesAgo: 1 }]);
    const result = await logsTraces(
      flags,
      queryDeps(dir, { configuredLog: () => "configured.jsonl" }),
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
    const deps = queryDeps(dir, {
      configuredLog: () => "log.jsonl",
      probe: async () => liveSessions([record], () => ""),
    });
    const result = await logsTraces(flags, deps);
    expect(result.text.split("\n")[0]).toContain(path.join("runs", "today", "statelog.jsonl"));
    expect(result.text).toContain("from-viewer");
  });

  it("with no log anywhere, refuses with the three ways forward", async () => {
    const result = await logsTraces(flags, queryDeps(dir));
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("No log given");
  });

  it("a refused selection exits 1", async () => {
    writeLog(dir, "log.jsonl", [{ traceId: "only", minutesAgo: 1 }]);
    const result = await logsTraces(
      { ...flags, log: "log.jsonl", all: true, last: 2 },
      queryDeps(dir),
    );
    expect(result).toMatchObject({ exitCode: 1, text: "--all and --last disagree about how many" });
  });
});
