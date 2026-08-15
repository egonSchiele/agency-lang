import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openOccurrenceLog } from "./occurrences.js";
import type { OccurrenceCandidate } from "./types.js";

const OUTPUT_ID = `out_${"a".repeat(64)}`;

let datasetDir: string;

beforeEach(() => {
  datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-occ-"));
});

afterEach(() => {
  fs.rmSync(datasetDir, { recursive: true, force: true });
});

function candidate(over: Partial<OccurrenceCandidate> = {}): OccurrenceCandidate {
  return {
    outputId: OUTPUT_ID,
    source: "agent-v1",
    origin: { kind: "file", itemKey: "good-1.txt" },
    ...over,
  };
}

describe("ensureOccurrence", () => {
  it("appends an occurrence the dataset has not seen", () => {
    expect(openOccurrenceLog(datasetDir).ensureOccurrence(candidate()).added).toBe(true);
  });

  it("returns the existing row on re-ingest rather than throwing", () => {
    // The whole reason replay goes through `find` rather than `appendExact`:
    // a second session builds the same id carrying a different timestamp.
    const first = openOccurrenceLog(datasetDir).ensureOccurrence(candidate());
    const second = openOccurrenceLog(datasetDir).ensureOccurrence(candidate());
    expect(second.added).toBe(false);
    expect(second.row.firstObservedAt).toBe(first.row.firstObservedAt);
  });

  it("does not write a second line when replaying", () => {
    openOccurrenceLog(datasetDir).ensureOccurrence(candidate());
    openOccurrenceLog(datasetDir).ensureOccurrence(candidate());
    expect(openOccurrenceLog(datasetDir).rows()).toHaveLength(1);
  });

  it("keeps two files with equal content as separate observations", () => {
    const log = openOccurrenceLog(datasetDir);
    log.ensureOccurrence(candidate({ origin: { kind: "file", itemKey: "a.txt" } }));
    const other = log.ensureOccurrence(candidate({ origin: { kind: "file", itemKey: "b.txt" } }));
    expect(other.added).toBe(true);
    expect(log.rows()).toHaveLength(2);
  });

  it("keeps two array elements at different indices separate", () => {
    const log = openOccurrenceLog(datasetDir);
    log.ensureOccurrence(candidate({ origin: { kind: "json", itemKey: "a.json", itemIndex: 0 } }));
    const other = log.ensureOccurrence(
      candidate({ origin: { kind: "json", itemKey: "a.json", itemIndex: 1 } }),
    );
    expect(other.added).toBe(true);
  });

  it("keeps equal elements in two JSON documents separate under one source", () => {
    const log = openOccurrenceLog(datasetDir);
    log.ensureOccurrence(candidate({ origin: { kind: "json", itemKey: "a.json", itemIndex: 0 } }));
    const other = log.ensureOccurrence(
      candidate({ origin: { kind: "json", itemKey: "b.json", itemIndex: 0 } }),
    );
    expect(other.added).toBe(true);
  });

  it("separates the same observation seen under two source names", () => {
    const log = openOccurrenceLog(datasetDir);
    log.ensureOccurrence(candidate({ source: "agent-v1" }));
    expect(log.ensureOccurrence(candidate({ source: "agent-v2" })).added).toBe(true);
  });

  it("separates two records observed from the same file path", () => {
    const log = openOccurrenceLog(datasetDir);
    log.ensureOccurrence(candidate());
    const other = log.ensureOccurrence(candidate({ outputId: `out_${"b".repeat(64)}` }));
    expect(other.added).toBe(true);
  });

  it("records a run origin with its provenance intact", () => {
    const log = openOccurrenceLog(datasetDir);
    const { row } = log.ensureOccurrence(candidate({
      origin: {
        kind: "run",
        traceId: "t-1",
        inputId: "news-01",
        finalOutputIndex: 2,
        runStartedAtMs: 1754000000000,
        models: ["claude-opus-5"],
        agent: { file: "news.agency" },
        rawTask: "Summarize",
        rawValue: { summary: "..." },
      },
    }));
    expect(row.origin).toMatchObject({ kind: "run", models: ["claude-opus-5"] });
  });
});
