import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStatelogScan, runScanToEnd, STATELOG_SCAN_CHUNK_BYTES } from "./mine.js";
import {
  envelope,
  promptCompletion,
  resetFixtureClock,
  writeStatelog,
  FIXTURE_EPOCH_MS,
} from "./testFixtures.js";

describe("createStatelogScan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-scan-"));
    resetFixtureClock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accumulates cost, models, time span, and the last agent name per trace", () => {
    const file = writeStatelog(path.join(tmpDir, "log.jsonl"), [
      envelope("t1", { type: "threadCreated", threadId: "0" }),
      envelope("t1", { type: "agentName", name: "first" }),
      promptCompletion("t1", "sonnet", 1.5),
      envelope("t1", { type: "agentName", name: "final" }),
      promptCompletion("t1", "opus", 2.0),
    ]);

    const result = runScanToEnd(createStatelogScan(file));
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    const trace = result.traces["t1"];
    expect(trace.costUsd).toBeCloseTo(3.5);
    expect(trace.models).toEqual(["sonnet", "opus"]);
    expect(trace.agentName).toBe("final");
    expect(trace.firstTsMs).toBe(FIXTURE_EPOCH_MS + 1_000);
    expect(trace.lastTsMs).toBe(FIXTURE_EPOCH_MS + 5_000);
  });

  it("a torn final line preserves the metrics before it and adds a warning", () => {
    const file = writeStatelog(path.join(tmpDir, "torn.jsonl"), [
      promptCompletion("t1", "sonnet", 1.0),
    ]);
    fs.appendFileSync(file, '{"format_version": 1, "trace_id": "t1", "data": {"type": "promptCom');

    const result = runScanToEnd(createStatelogScan(file));
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.traces["t1"].costUsd).toBeCloseTo(1.0);
    expect(result.warnings).toHaveLength(1);
  });

  it("a file with no recoverable events fails with a warning", () => {
    const file = path.join(tmpDir, "junk.jsonl");
    fs.writeFileSync(file, "junk line one\njunk line two\n");

    const result = runScanToEnd(createStatelogScan(file));

    expect(result.kind).toBe("failed");
  });

  it("a missing file fails with a warning instead of throwing", () => {
    const result = runScanToEnd(createStatelogScan(path.join(tmpDir, "gone.jsonl")));
    expect(result.kind).toBe("failed");
  });

  it("one advance reads at most one chunk of a multi-megabyte file", () => {
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < 20_000; i++) {
      events.push(promptCompletion("big", "sonnet", 0.001));
    }
    const file = writeStatelog(path.join(tmpDir, "big.jsonl"), events);
    expect(fs.statSync(file).size).toBeGreaterThan(2 * STATELOG_SCAN_CHUNK_BYTES);

    const scan = createStatelogScan(file);
    const doneAfterOne = scan.advance();

    expect(doneAfterOne).toBe(false);
    const partial = scan.peekTraces();
    const seenSoFar = partial["big"]?.eventCount ?? 0;
    expect(seenSoFar).toBeGreaterThan(0);
    expect(seenSoFar).toBeLessThan(20_000);

    const result = runScanToEnd(scan);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.traces["big"].eventCount).toBe(20_000);
    expect(result.traces["big"].costUsd).toBeCloseTo(20, 1);
  });

  it("a multi-byte UTF-8 character split across chunk boundaries survives", () => {
    const pad = "x".repeat(STATELOG_SCAN_CHUNK_BYTES - 20);
    const events = [
      envelope("t1", { type: "note", blob: pad + "日本語テキスト" }),
      envelope("t1", { type: "agentName", name: "after-boundary-日本" }),
    ];
    const file = writeStatelog(path.join(tmpDir, "utf8.jsonl"), events);

    const result = runScanToEnd(createStatelogScan(file));
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.warnings).toEqual([]);
    expect(result.traces["t1"].agentName).toBe("after-boundary-日本");
  });
});
