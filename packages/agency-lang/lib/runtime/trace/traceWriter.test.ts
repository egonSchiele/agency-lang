import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter, scanExistingTraceFile } from "./traceWriter.js";
import { FileSink, CallbackSink } from "./sinks.js";
import type { TraceLine } from "./types.js";
import { Checkpoint } from "../state/checkpointStore.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const RUN_ID = "test-run-id";

function readTrace(filePath: string) {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function makeCheckpoint(
  overrides: Partial<Record<string, any>> = {},
): Checkpoint {
  return new Checkpoint({
    id: 0,
    nodeId: "start",
    moduleId: "main.agency",
    scopeName: "myNode",
    stepPath: "0",
    label: null,
    pinned: false,
    stack: {
      stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: ["start"],
    },
    globals: {
      store: { "main.agency": { x: 1 } },
      initializedModules: ["main.agency"],
    },
    ...overrides,
  });
}

describe("TraceWriter", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a header as the first line", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.close();

    const lines = readTrace(tracePath);
    expect(lines[0].type).toBe("header");
    expect(lines[0].program).toBe("test.agency");
    expect(lines[0].version).toBe(1);
    expect(typeof lines[0].agencyVersion).toBe("string");
    expect(lines[0].agencyVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("writes chunks before their manifest", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.close();

    const lines = readTrace(tracePath);
    const chunkIndices = lines
      .map((l: any, i: number) => (l.type === "chunk" ? i : -1))
      .filter((i: number) => i >= 0);
    const manifestIndex = lines.findIndex((l: any) => l.type === "manifest");
    for (const ci of chunkIndices) {
      expect(ci).toBeLessThan(manifestIndex);
    }
  });

  it("deduplicates identical globals across checkpoints", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);

    await writer.writeCheckpoint(makeCheckpoint({ id: 0, stepPath: "0" }));
    await writer.writeCheckpoint(
      makeCheckpoint({
        id: 1,
        stepPath: "1",
        stack: {
          stack: [{ args: {}, locals: { x: 99 }, threads: null, step: 1 }],
          mode: "serialize",
          other: {},
          deserializeStackLength: 0,
          nodesTraversed: ["start"],
        },
      }),
    );
    await writer.close();

    const lines = readTrace(tracePath);
    const chunks = lines.filter((l: any) => l.type === "chunk");
    // 2 different frame chunks + 1 shared globals chunk = 3
    expect(chunks).toHaveLength(3);
  });

  it("manifest contains checkpoint metadata alongside hashed fields", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeCheckpoint(
      makeCheckpoint({ label: "test-label", pinned: true }),
    );
    await writer.close();

    const lines = readTrace(tracePath);
    const manifest = lines.find((l: any) => l.type === "manifest");
    expect(manifest.id).toBe(0);
    expect(manifest.nodeId).toBe("start");
    expect(manifest.moduleId).toBe("main.agency");
    expect(manifest.label).toBe("test-label");
    expect(manifest.pinned).toBe(true);
    expect(manifest.stack.mode).toBe("serialize");
    expect(manifest.stack.nodesTraversed).toEqual(["start"]);
    expect(typeof manifest.stack.stack[0]).toBe("string");
    expect(manifest.globals.initializedModules).toEqual(["main.agency"]);
    expect(typeof manifest.globals.store["main.agency"]).toBe("string");
  });

  it("emits footer on close with correct counts", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.close();

    const lines = readTrace(tracePath);
    const footer = lines.find((l: any) => l.type === "footer");
    expect(footer).toBeDefined();
    expect(footer.checkpointCount).toBe(1);
    expect(footer.chunkCount).toBeGreaterThan(0);
    expect(typeof footer.timestamp).toBe("string");
  });

  it("fans out to multiple sinks", async () => {
    const callbackLines: TraceLine[] = [];
    const callbackSink = new CallbackSink("test-id", (event) => {
      callbackLines.push(event.line);
    });
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
      callbackSink,
    ]);
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.close();

    const fileLines = readTrace(tracePath);
    // Both sinks should have received the same number of lines
    expect(callbackLines.length).toBe(fileLines.length);
  });

  it("sink error does not prevent other sinks from receiving data", async () => {
    const callbackLines: TraceLine[] = [];
    const errorSink = {
      writeLine: () => {
        throw new Error("sink error");
      },
    };
    const goodSink = new CallbackSink("test-id", (event) => {
      callbackLines.push(event.line);
    });
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      errorSink,
      goodSink,
    ]);
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.close();

    // Good sink should still have received data despite error sink
    expect(callbackLines.length).toBeGreaterThan(0);
  });

  it("writes static-state line", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeStaticState({ prompt: "hello", count: 42 });
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.close();

    const lines = readTrace(tracePath);
    const staticLine = lines.find((l: any) => l.type === "static-state");
    expect(staticLine).toBeDefined();
    expect(staticLine.values).toEqual({ prompt: "hello", count: 42 });
  });

  it("writeHeader is idempotent within a single writer", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeHeader();
    await writer.writeHeader();
    await writer.writeCheckpoint(makeCheckpoint()); // also calls writeHeader internally
    await writer.close(); // and so does close (and pause-from-close)

    const lines = readTrace(tracePath);
    const headers = lines.filter((l: any) => l.type === "header");
    expect(headers).toHaveLength(1);
  });
});

describe("scanExistingTraceFile", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-scan-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result for a non-existent file", async () => {
    const result = await scanExistingTraceFile(
      path.join(tmpDir, "missing.agencytrace"),
    );
    expect(result.hasHeader).toBe(false);
    expect(result.chunkHashes.size).toBe(0);
  });

  it("returns empty result for an empty file", async () => {
    fs.writeFileSync(tracePath, "");
    const result = await scanExistingTraceFile(tracePath);
    expect(result.hasHeader).toBe(false);
    expect(result.chunkHashes.size).toBe(0);
  });

  it("detects an existing header and collects chunk hashes", async () => {
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.pause();

    const result = await scanExistingTraceFile(tracePath);
    expect(result.hasHeader).toBe(true);
    expect(result.chunkHashes.size).toBeGreaterThan(0);

    // Sanity-check: every chunk hash in the file appears in the scan.
    const lines = readTrace(tracePath);
    const fileHashes = lines
      .filter((l: any) => l.type === "chunk")
      .map((l: any) => l.hash);
    for (const h of fileHashes) expect(result.chunkHashes.has(h)).toBe(true);
  });

  it("skips malformed lines without bailing on later valid ones", async () => {
    // Build: a header, a chunk, a malformed line, another chunk.
    const writer = new TraceWriter(RUN_ID, "test.agency", [
      new FileSink(tracePath),
    ]);
    await writer.writeCheckpoint(makeCheckpoint());
    await writer.pause();

    fs.appendFileSync(tracePath, "this is not json\n");
    fs.appendFileSync(
      tracePath,
      JSON.stringify({ type: "chunk", hash: "abcd", data: { x: 1 } }) + "\n",
    );

    const result = await scanExistingTraceFile(tracePath);
    expect(result.hasHeader).toBe(true);
    expect(result.chunkHashes.has("abcd")).toBe(true);
  });
});

describe("TraceWriter.create cross-segment dedup", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-create-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first writer on an empty file emits a header and chunks normally", async () => {
    const w = await TraceWriter.create({
      runId: RUN_ID,
      traceConfig: { traceFile: tracePath, program: "test.agency" },
    });
    expect(w).not.toBeNull();
    await w!.writeCheckpoint(makeCheckpoint());
    await w!.pause();

    const lines = readTrace(tracePath);
    expect(lines.filter((l: any) => l.type === "header")).toHaveLength(1);
    expect(lines.filter((l: any) => l.type === "chunk").length).toBeGreaterThan(0);
  });

  it("second writer on a file that already has a header does not emit a duplicate header", async () => {
    const w1 = await TraceWriter.create({
      runId: RUN_ID,
      traceConfig: { traceFile: tracePath, program: "test.agency" },
    });
    await w1!.writeCheckpoint(makeCheckpoint());
    await w1!.pause();

    const w2 = await TraceWriter.create({
      runId: RUN_ID,
      traceConfig: { traceFile: tracePath, program: "test.agency" },
    });
    await w2!.writeCheckpoint(makeCheckpoint({ id: 1, stepPath: "1" }));
    await w2!.close();

    const lines = readTrace(tracePath);
    expect(lines.filter((l: any) => l.type === "header")).toHaveLength(1);
  });

  it("second writer dedups chunks already on disk", async () => {
    const w1 = await TraceWriter.create({
      runId: RUN_ID,
      traceConfig: { traceFile: tracePath, program: "test.agency" },
    });
    await w1!.writeCheckpoint(makeCheckpoint());
    await w1!.pause();

    const linesAfterFirst = readTrace(tracePath);
    const chunksAfterFirst = linesAfterFirst.filter(
      (l: any) => l.type === "chunk",
    ).length;
    expect(chunksAfterFirst).toBeGreaterThan(0);

    // Second writer writes IDENTICAL checkpoint contents — every chunk hash
    // should already be in the on-disk set, so no new chunks emitted.
    const w2 = await TraceWriter.create({
      runId: RUN_ID,
      traceConfig: { traceFile: tracePath, program: "test.agency" },
    });
    await w2!.writeCheckpoint(makeCheckpoint());
    await w2!.pause();

    const linesAfterSecond = readTrace(tracePath);
    const chunksAfterSecond = linesAfterSecond.filter(
      (l: any) => l.type === "chunk",
    ).length;
    expect(chunksAfterSecond).toBe(chunksAfterFirst);
    // Manifest count went up though.
    const manifestsAfterSecond = linesAfterSecond.filter(
      (l: any) => l.type === "manifest",
    ).length;
    expect(manifestsAfterSecond).toBe(2);
  });

  it("falls back gracefully on a malformed file", async () => {
    fs.writeFileSync(tracePath, "garbage that is not json\n");

    const w = await TraceWriter.create({
      runId: RUN_ID,
      traceConfig: { traceFile: tracePath, program: "test.agency" },
    });
    await w!.writeCheckpoint(makeCheckpoint());
    await w!.close();

    // The pre-existing garbage line stays where it was; the new writer
    // appended a header + content after. Parsing the file as JSONL would
    // throw on the garbage line, so just check the new lines exist.
    const raw = fs.readFileSync(tracePath, "utf-8");
    expect(raw).toContain('"type":"header"');
    expect(raw).toContain('"type":"manifest"');
    expect(raw).toContain('"type":"footer"');
  });
});
