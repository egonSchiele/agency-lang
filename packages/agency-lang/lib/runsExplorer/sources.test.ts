import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSources } from "./sources.js";
import { writeGradedRun, writeMultiTraceStatelog } from "./testFixtures.js";

describe("discoverSources", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-sources-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies a run directory and routes a sole run dir to the viewer on it", () => {
    const runDir = writeGradedRun(tmpDir);

    const discovery = discoverSources([runDir]);

    expect(discovery.sources).toEqual([{ kind: "runDir", dir: runDir }]);
    expect(discovery.route).toBe("runDirectory");
    expect(discovery.errors).toEqual([]);
  });

  it("scans a parent directory one level deep for run dirs and routes to the explorer", () => {
    writeGradedRun(tmpDir, "run-1");
    writeGradedRun(tmpDir, "run-2");
    fs.mkdirSync(path.join(tmpDir, "not-a-run"));

    const discovery = discoverSources([tmpDir]);

    expect(discovery.sources.map((s) => s.kind)).toEqual(["runDir", "runDir"]);
    expect(discovery.route).toBe("explorer");
  });

  it("classifies a statelog file and routes a sole statelog to the viewer", () => {
    const file = writeMultiTraceStatelog(tmpDir);

    const discovery = discoverSources([file]);

    expect(discovery.sources).toEqual([{ kind: "statelog", file }]);
    expect(discovery.route).toBe("viewer");
  });

  it("mixed paths merge and route to the explorer", () => {
    const runDir = writeGradedRun(tmpDir);
    const file = writeMultiTraceStatelog(tmpDir);

    const discovery = discoverSources([runDir, file]);

    expect(discovery.sources).toHaveLength(2);
    expect(discovery.route).toBe("explorer");
  });

  it("skips blank JSONL prefixes when sniffing", () => {
    const file = path.join(tmpDir, "blanks.jsonl");
    fs.writeFileSync(
      file,
      "\n\n  \n" + JSON.stringify({ format_version: 1, trace_id: "t", data: {} }) + "\n",
    );

    expect(discoverSources([file]).sources).toEqual([{ kind: "statelog", file }]);
  });

  it("a sole empty file routes to the viewer (which owns empty-file handling)", () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "");

    const discovery = discoverSources([file]);

    expect(discovery.sources).toEqual([{ kind: "statelog", file }]);
    expect(discovery.route).toBe("viewer");
  });

  it("rejects invalid JSON and valid JSON without envelope fields", () => {
    const invalid = path.join(tmpDir, "invalid.jsonl");
    fs.writeFileSync(invalid, "not json at all\n");
    const nonEnvelope = path.join(tmpDir, "not-a-log.json");
    fs.writeFileSync(nonEnvelope, JSON.stringify({ hello: "world" }) + "\n");

    const discovery = discoverSources([invalid, nonEnvelope]);

    expect(discovery.sources).toEqual([]);
    expect(discovery.errors).toHaveLength(2);
    expect(discovery.errors[0]).toContain("run directory");
    expect(discovery.errors[0]).toContain("statelog");
  });

  it("a first nonblank line larger than 4 KiB still classifies", () => {
    const file = path.join(tmpDir, "big-line.jsonl");
    const bigEvent = {
      format_version: 1,
      trace_id: "t",
      data: { type: "x", blob: "y".repeat(8192) },
    };
    fs.writeFileSync(file, JSON.stringify(bigEvent) + "\n");

    expect(discoverSources([file]).sources).toEqual([{ kind: "statelog", file }]);
  });

  it("a first line beyond the sniff maximum is an explicit classification error", () => {
    const file = path.join(tmpDir, "huge-line.jsonl");
    fs.writeFileSync(file, "x".repeat(1024 * 1024 + 10));

    const discovery = discoverSources([file]);

    expect(discovery.sources).toEqual([]);
    expect(discovery.errors).toHaveLength(1);
    expect(discovery.errors[0]).toContain("first line");
  });

  it("a torn statelog still classifies as a run directory (contents are a row problem)", () => {
    const runDir = path.join(tmpDir, "torn-run");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, "statelog.jsonl"), '{"format_version": 1, "tra');

    const discovery = discoverSources([runDir]);

    expect(discovery.sources).toEqual([{ kind: "runDir", dir: runDir }]);
  });

  it("a missing path is an error naming the accepted kinds", () => {
    const discovery = discoverSources([path.join(tmpDir, "nope")]);

    expect(discovery.errors).toHaveLength(1);
  });

  it("a directory with no runs inside is an error", () => {
    const empty = path.join(tmpDir, "nothing-here");
    fs.mkdirSync(empty);

    const discovery = discoverSources([empty]);

    expect(discovery.sources).toEqual([]);
    expect(discovery.errors).toHaveLength(1);
  });
});
