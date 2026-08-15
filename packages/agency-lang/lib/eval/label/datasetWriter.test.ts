import { describe, expect, it, vi } from "vitest";

import { createDatasetWriter } from "./datasetWriter.js";
import type { IngestResult, LabelDataset } from "./dataset.js";
import type { LoadedBatch } from "./load/types.js";
import type { DatasetLock } from "./lock.js";

const BATCH: LoadedBatch = { occurrences: [], skips: [] };
const RESULT = {
  recordsAdded: 1,
  recordsReplayed: 0,
  occurrencesAdded: 1,
  occurrencesReplayed: 0,
  skips: [],
  newFieldNames: [],
} as unknown as IngestResult;

function fakeLock(): DatasetLock & { released: () => number } {
  let count = 0;
  return {
    release: () => {
      count += 1;
    },
    released: () => count,
  } as DatasetLock & { released: () => number };
}

function fakeDataset(over: Partial<LabelDataset> = {}): LabelDataset & { closed: () => number } {
  let count = 0;
  return {
    ingest: () => RESULT,
    close: () => {
      count += 1;
    },
    closed: () => count,
    ...over,
  } as unknown as LabelDataset & { closed: () => number };
}

const request = { datasetDir: "/tmp/ds", batch: BATCH, reportWarning: () => {} };

describe("datasetWriter", () => {
  it("acquires a lock, ingests, then closes and releases on success", () => {
    const lock = fakeLock();
    const dataset = fakeDataset();
    const writer = createDatasetWriter({
      acquireLock: () => lock,
      openDataset: () => dataset,
    });

    expect(writer.ingest(request)).toBe(RESULT);
    expect(dataset.closed()).toBe(1);
    expect(lock.released()).toBe(1);
  });

  it("still closes and releases when ingest throws", () => {
    const lock = fakeLock();
    const dataset = fakeDataset({
      ingest: () => {
        throw new Error("ingest boom");
      },
    });
    const writer = createDatasetWriter({ acquireLock: () => lock, openDataset: () => dataset });

    expect(() => writer.ingest(request)).toThrow("ingest boom");
    expect(dataset.closed()).toBe(1);
    expect(lock.released()).toBe(1);
  });

  it("releases the lock when opening the dataset throws", () => {
    const lock = fakeLock();
    const writer = createDatasetWriter({
      acquireLock: () => lock,
      openDataset: () => {
        throw new Error("open boom");
      },
    });

    expect(() => writer.ingest(request)).toThrow("open boom");
    expect(lock.released()).toBe(1);
  });
});
