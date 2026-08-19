import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunsLoader, loadAllRuns, type LoaderEvent } from "./loader.js";
import type { RunRow } from "./rows.js";
import {
  resetFixtureClock,
  writeGradedRun,
  writeKilledRun,
  writeMultiTraceStatelog,
} from "./testFixtures.js";

function drain(events: LoaderEvent[][]): LoaderEvent[] {
  return events.flat();
}

function upserts(events: LoaderEvent[]): RunRow[] {
  return events
    .filter((e) => e.kind === "upsert")
    .map((e) => (e as { kind: "upsert"; row: RunRow }).row);
}

function runLoaderToEnd(sources: Parameters<typeof createRunsLoader>[0]) {
  const loader = createRunsLoader(sources);
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

  it("a run directory completes in one advance, from one snapshot", () => {
    const runDir = writeGradedRun(tmpDir);
    const { events, advances } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);

    // announce, load, done
    expect(advances).toBe(3);
    const rows = upserts(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(0.5);
    expect(rows[0].tests).toHaveLength(1);
    expect(rows[0].backfilled).toBe(true);
    expect(events[events.length - 1].kind).toBe("done");
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

  it("a killed run derives the killed status from the harness row", () => {
    const runDir = writeKilledRun(tmpDir);
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);
    const rows = upserts(events);
    expect(rows[rows.length - 1].status).toBe("killed");
    expect(rows[rows.length - 1].costUsd).toBeCloseTo(3.0);
  });

  it("a malformed line in a run directory's statelog is a warning on the row, not a crash", () => {
    const runDir = writeGradedRun(tmpDir);
    fs.appendFileSync(path.join(runDir, "statelog.jsonl"), "{ torn\n");
    const { events } = runLoaderToEnd([{ kind: "runDir", dir: runDir }]);
    const rows = upserts(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].tests).toHaveLength(1);
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
});

describe("loadAllRuns", () => {
  it("returns complete rows for mixed sources", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-loadall-"));
    resetFixtureClock();
    writeGradedRun(tmpDir, "run-a");
    writeKilledRun(tmpDir, "run-b");
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
