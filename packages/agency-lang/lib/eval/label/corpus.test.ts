import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openCorpusLog } from "./corpus.js";
import { makeOutputId } from "./ids.js";

let datasetDir: string;

beforeEach(() => {
  datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-corpus-"));
});

afterEach(() => {
  fs.rmSync(datasetDir, { recursive: true, force: true });
});

describe("ensureRecord", () => {
  it("adds a field map the corpus has not seen", () => {
    expect(openCorpusLog(datasetDir).ensureRecord({ output: "hello" }).added).toBe(true);
  });

  it("derives the row's id from its fields", () => {
    const { row } = openCorpusLog(datasetDir).ensureRecord({ output: "hello" });
    expect(row.outputId).toBe(makeOutputId({ output: "hello" }));
  });

  it("returns the existing row and the FIRST capturedAt on a later ingest", () => {
    // capturedAt is not part of the identity, so a fresh timestamp on a second
    // ingest would otherwise be rejected as identity reuse with new content.
    const first = openCorpusLog(datasetDir).ensureRecord({ output: "hello" });
    const second = openCorpusLog(datasetDir).ensureRecord({ output: "hello" });
    expect(second.added).toBe(false);
    expect(second.row.capturedAt).toBe(first.row.capturedAt);
  });

  it("does not write a second line when replaying", () => {
    openCorpusLog(datasetDir).ensureRecord({ output: "hello" });
    openCorpusLog(datasetDir).ensureRecord({ output: "hello" });
    expect(openCorpusLog(datasetDir).rows()).toHaveLength(1);
  });

  it("treats two sources emitting equal fields as one record", () => {
    const log = openCorpusLog(datasetDir);
    log.ensureRecord({ task: "Summarize", output: "same" });
    const second = log.ensureRecord({ task: "Summarize", output: "same" });
    expect(second.added).toBe(false);
    expect(log.rows()).toHaveLength(1);
  });

  it("treats a different field map as a different record", () => {
    const log = openCorpusLog(datasetDir);
    log.ensureRecord({ output: "one" });
    expect(log.ensureRecord({ output: "two" }).added).toBe(true);
    expect(log.rows()).toHaveLength(2);
  });

  it("rejects a record with no fields", () => {
    expect(() => openCorpusLog(datasetDir).ensureRecord({})).toThrow();
  });

  it("finds a record written by an earlier session", () => {
    const { row } = openCorpusLog(datasetDir).ensureRecord({ output: "hello" });
    expect(openCorpusLog(datasetDir).find(row.outputId)).toEqual(row);
  });
});
