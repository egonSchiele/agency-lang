import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "./traceWriter.js";
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
});
