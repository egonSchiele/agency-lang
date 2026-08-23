import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRunDirectory } from "@/runDirectory/runDir.js";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";

import { buildRunRowFromDirectory } from "./rows.js";
import { writeGradedRun, writeKilledRun } from "./testFixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-rows-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function rowFor(dir: string) {
  const snapshot = readRunDirectory(dir, { reportWarning: () => {} });
  return buildRunRowFromDirectory(snapshot, { kind: "runDir", dir });
}

describe("buildRunRowFromDirectory", () => {
  it("builds a complete row from one snapshot: no backfill left", () => {
    const dir = writeGradedRun(tmpDir);
    const row = rowFor(dir);
    expect(row.key).toBe(dir);
    expect(row.backfilled).toBe(true);
    expect(row.status).toBe("ok");
    expect(row.costUsd).toBeCloseTo(2.0);
    expect(row.models).toEqual(["test-model"]);
    expect(row.warnings).toEqual([]);
  });

  it("per-test rows carry the test id, trace id, and the effective scores", () => {
    const row = rowFor(writeGradedRun(tmpDir));
    expect(
      row.tests.map((test) => [test.inputId, test.traceId, test.score, test.gatesPassed]),
    ).toEqual([["t1", "t1", 0.5, false]]);
    expect(row.score).toBe(0.5);
    expect(row.gatesPassed).toBe(false);
  });

  it("the test opens the run's statelog, so the viewer can focus its trace", () => {
    const dir = writeGradedRun(tmpDir);
    const row = rowFor(dir);
    expect(new Set(row.tests.map((test) => test.statelogPath))).toEqual(
      new Set([path.join(dir, "statelog.jsonl")]),
    );
  });

  it("a run the harness killed reads as killed, not merely failed", () => {
    const row = rowFor(writeKilledRun(tmpDir));
    expect(row.tests[0].status).toBe("failed");
    expect(row.status).toBe("killed");
    expect(row.costUsd).toBeCloseTo(3.0);
  });

  it("a run that never wrote a trace is one failed test row, not an empty run", () => {
    const dir = writeRunDirectory(
      {
        traceId: "s1",
        test: { id: "t1", input: "x" },
        wroteStatelog: false,
        ended: "error",
        agentLabel: "claude -p {task}",
      },
      path.join(tmpDir, "silent-run"),
    );
    const row = rowFor(dir);
    expect(row.tests.map((test) => [test.inputId, test.traceId, test.status])).toEqual([
      ["t1", "s1", "failed"],
    ]);
    expect(row.status).toBe("failed");
    expect(row.agent).toBe("claude -p {task}");
  });

  it("names the agent from the harness label when the trace never named itself", () => {
    expect(rowFor(writeGradedRun(tmpDir)).agent).toBe("regex-log.agency");
    expect(rowFor(writeKilledRun(tmpDir)).agent).toBe("claude -p {task}");
  });
});
