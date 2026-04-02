import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "./traceWriter.js";
import { Checkpoint } from "../state/checkpointStore.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function readTrace(filePath: string) {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function makeCheckpoint(overrides: Partial<Record<string, any>> = {}): Checkpoint {
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

  it("writes a header as the first line", () => {
    const writer = new TraceWriter(tracePath, "test.agency");

    const lines = readTrace(tracePath);
    expect(lines[0].type).toBe("header");
    expect(lines[0].program).toBe("test.agency");
    expect(lines[0].version).toBe(1);
  });

  it("writes chunks before their manifest", () => {
    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(makeCheckpoint());

    const lines = readTrace(tracePath);
    const chunkIndices = lines
      .map((l: any, i: number) => (l.type === "chunk" ? i : -1))
      .filter((i: number) => i >= 0);
    const manifestIndex = lines.findIndex((l: any) => l.type === "manifest");
    for (const ci of chunkIndices) {
      expect(ci).toBeLessThan(manifestIndex);
    }
  });

  it("deduplicates identical globals across checkpoints", () => {
    const writer = new TraceWriter(tracePath, "test.agency");

    writer.writeCheckpoint(makeCheckpoint({ id: 0, stepPath: "0" }));
    writer.writeCheckpoint(makeCheckpoint({
      id: 1,
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { x: 99 }, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["start"],
      },
    }));

    const lines = readTrace(tracePath);
    const chunks = lines.filter((l: any) => l.type === "chunk");
    // 2 different frame chunks + 1 shared globals chunk = 3
    expect(chunks).toHaveLength(3);
  });

  it("manifest contains checkpoint metadata alongside hashed fields", () => {
    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(makeCheckpoint({ label: "test-label", pinned: true }));

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
});
