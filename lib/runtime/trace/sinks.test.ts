import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileSink, CallbackSink } from "./sinks.js";
import type { TraceLine } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function readJsonl(filePath: string): any[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const sampleHeader: TraceLine = {
  type: "header",
  version: 1,
  agencyVersion: "0.0.0",
  program: "test.agency",
  timestamp: "2026-01-01T00:00:00Z",
  config: { hashAlgorithm: "sha256" },
};

const sampleChunk: TraceLine = {
  type: "chunk",
  hash: "abc123",
  data: { x: 1 },
};

describe("FileSink", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-test-"));
    filePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes JSONL lines to file", async () => {
    const sink = new FileSink(filePath);
    await sink.writeLine(sampleHeader);
    await sink.writeLine(sampleChunk);
    await sink.close();

    const lines = readJsonl(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("header");
    expect(lines[1].type).toBe("chunk");
  });

  it("close() flushes pending writes", async () => {
    const sink = new FileSink(filePath);
    await sink.writeLine(sampleHeader);
    await sink.close();

    const lines = readJsonl(filePath);
    expect(lines).toHaveLength(1);
  });
});

describe("CallbackSink", () => {
  it("wraps each line in a TraceEvent envelope with executionId", async () => {
    const events: any[] = [];
    const sink = new CallbackSink("exec-123", (event) => { events.push(event); });

    await sink.writeLine(sampleHeader);
    await sink.writeLine(sampleChunk);

    expect(events).toHaveLength(2);
    expect(events[0].executionId).toBe("exec-123");
    expect(events[0].line).toBe(sampleHeader);
    expect(events[1].executionId).toBe("exec-123");
    expect(events[1].line).toBe(sampleChunk);
  });

  it("handles async callbacks", async () => {
    const events: any[] = [];
    const sink = new CallbackSink("exec-456", async (event) => {
      await new Promise((r) => setTimeout(r, 1));
      events.push(event);
    });

    await sink.writeLine(sampleHeader);
    expect(events).toHaveLength(1);
    expect(events[0].executionId).toBe("exec-456");
  });
});
