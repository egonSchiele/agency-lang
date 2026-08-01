import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunsLoader, loadAllRuns, type LoaderEvent } from "./loader.js";
import type { RunRow } from "./rows.js";
import {
  resetFixtureClock, writeCorruptRun, writeGradedRun, writeKilledRun,
  writeLegacyRun, writeMultiTraceStatelog,
} from "./testFixtures.js";

function drain(events: LoaderEvent[][]): LoaderEvent[] {
  return events.flat();
}

function upserts(events: LoaderEvent[]): RunRow[] {
  return events.filter((e) => e.kind === "upsert").map((e) => (e as { kind: "upsert"; row: RunRow }).row);
}

function runLoaderToEnd(sources: Parameters<typeof createRunsLoader>[0], deps?: Parameters<typeof createRunsLoader>[1]) {
  const loader = createRunsLoader(sources, deps);
  const batches: LoaderEvent[][] = [];
  let advances = 0;
  while (!loader.isDone()) {
    batches.push(loader.advance());
    advances += 1;
    if (advances > 10_000) {
      throw new Error("loader never finished");
    }
  }
  return { events: drain(batches), advances };
}

describe("createRunsLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-loader-"));
    resetFixtureClock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a modern run completes in phase 1 with exactly two content reads", () => {
    const runDir = writeGradedRun(tmpDir);
    const reads: string[] = [];
    const { events } = runLoaderToEnd(
      [{ kind: "runDir", dir: runDir }],
      { readFile: (p) => { reads.push(p); return fs.readFileSync(p, "utf-8"); } },
    );

    expect(reads.sort()).toEqual([
      path.join(runDir, "config.json"),
      path.join(runDir, "summary.json"),
    ]);
    const rows = upserts(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("regex-log");
    expect(rows[0].score).toBe(0.9);
    expect(rows[0].backfilled).toBe(true);
    const done = events[events.length - 1];
    expect(done.kind).toBe("done");
  });

  it("emits discovered progress before the first upsert", () => {
    const runDir = writeGradedRun(tmpDir);
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);
    const first = events[0];
    if (first.kind !== "progress") {
      throw new Error(`expected progress first, got ${first.kind}`);
    }
    expect(first.total).toBe(1);
  });

  it("a legacy run backfills from records and the statelog over multiple advances", () => {
    const runDir = writeLegacyRun(tmpDir);
    const { events, advances } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);

    expect(advances).toBeGreaterThanOrEqual(3);
    const rows = upserts(events);
    const first = rows[0];
    expect(first.backfilled).toBe(false);
    expect(first.costUsd).toBeNull();
    const last = rows[rows.length - 1];
    expect(last.backfilled).toBe(true);
    expect(last.costUsd).toBeCloseTo(2.5);
    expect(last.models).toEqual(["opus"]);
    expect(last.agent).toBe("legacy-agent");
    expect(last.startedAtMs).not.toBeNull();
  });

  it("a killed run mines the statelog and derives the killed status", () => {
    const runDir = writeKilledRun(tmpDir);
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);

    const rows = upserts(events);
    const last = rows[rows.length - 1];
    expect(last.status).toBe("killed");
    expect(last.costUsd).toBeCloseTo(6.0);
    expect(last.models).toEqual(["sonnet"]);
    expect(last.agent).toBe("claude -p {task}");
    expect(last.backfilled).toBe(true);
  });

  it("a corrupt summary becomes a visible failed row, not a crash", () => {
    const runDir = writeCorruptRun(tmpDir);
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);

    const rows = upserts(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].score).toBeNull();
    expect(rows[0].warnings.length).toBeGreaterThan(0);
  });

  it("a corrupt config keeps the run and carries a warning", () => {
    const runDir = writeGradedRun(tmpDir);
    fs.writeFileSync(path.join(runDir, "config.json"), "{ torn");
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);

    const rows = upserts(events);
    expect(rows[0].score).toBe(0.9);
    expect(rows[0].suite).toBe("—");
    expect(rows[0].warnings.length).toBeGreaterThan(0);
  });

  it("a multi-trace statelog emits one trace row per recovered trace", () => {
    const file = writeMultiTraceStatelog(tmpDir);
    const { events } = runLoaderToEnd([{ kind: "statelog", file }]);

    const rows = upserts(events);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "trace")).toBe(true);
    expect(rows[0].key).toBe(`${file}#trace-a`);
    expect(rows[1].agent).toBe("named-trace");
    expect(rows[0].costUsd).toBeCloseTo(0.05);
  });

  it("an unrecoverable statelog emits one failed source row", () => {
    const file = path.join(tmpDir, "junk.jsonl");
    fs.writeFileSync(file, "junk\nmore junk\n");
    const { events } = runLoaderToEnd([{ kind: "statelog", file }]);

    const rows = upserts(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].warnings.length).toBeGreaterThan(0);
  });

  it("backfill progress is reported as its own phase", () => {
    const runDir = writeLegacyRun(tmpDir);
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);
    const phases = events.filter((e) => e.kind === "progress").map((e) => (e as { phase: string }).phase);
    expect(phases).toContain("summary");
    expect(phases).toContain("backfill");
  });
});

describe("loadAllRuns", () => {
  it("returns fully backfilled rows for mixed sources", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-loadall-"));
    resetFixtureClock();
    writeGradedRun(tmpDir, "run-a");
    writeLegacyRun(tmpDir, "run-b");
    const file = writeMultiTraceStatelog(tmpDir);

    const rows = loadAllRuns([
      { kind: "runDir", dir: path.join(tmpDir, "run-a") },
      { kind: "runDir", dir: path.join(tmpDir, "run-b") },
      { kind: "statelog", file },
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.backfilled)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
