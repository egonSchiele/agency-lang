import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "./traceWriter.js";
import { TraceReader } from "./traceReader.js";
import { Checkpoint } from "../state/checkpointStore.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("TraceReader", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSimpleTrace(count: number) {
    const writer = new TraceWriter(tracePath, "test.agency");
    for (let i = 0; i < count; i++) {
      writer.writeCheckpoint(new Checkpoint({
        id: i,
        nodeId: "start",
        moduleId: "main.agency",
        scopeName: "myNode",
        stepPath: String(i),
        stack: {
          stack: [{ args: {}, locals: { x: i }, threads: null, step: i }],
          mode: "serialize",
          other: {},
          deserializeStackLength: 0,
          nodesTraversed: ["start"],
        },
        globals: {
          store: { "main.agency": { count: 0 } },
          initializedModules: ["main.agency"],
        },
      }));
    }

  }

  it("exposes header and checkpoints", () => {
    writeSimpleTrace(3);
    const reader = TraceReader.fromFile(tracePath);

    expect(reader.header.program).toBe("test.agency");
    expect(reader.checkpoints).toHaveLength(3);
  });

  it("returns fully reconstructed Checkpoint instances", () => {
    writeSimpleTrace(3);
    const reader = TraceReader.fromFile(tracePath);

    const cp = reader.checkpoints[1];
    expect(cp).toBeInstanceOf(Checkpoint);
    expect(cp.stack.stack[0].locals.x).toBe(1);
    expect(cp.stack.stack[0].step).toBe(1);
    expect(cp.nodeId).toBe("start");
  });

  it("roundtrips complex checkpoint data", () => {
    const writer = new TraceWriter(tracePath, "test.agency");

    const cp = new Checkpoint({
      id: 0,
      nodeId: "process",
      moduleId: "main.agency",
      scopeName: "processNode",
      stepPath: "3",
      stack: {
        stack: [
          { args: { name: "Alice" }, locals: { result: "hello" }, threads: null, step: 3 },
          { args: {}, locals: {}, threads: null, step: 0 },
        ],
        mode: "serialize",
        other: { foo: "bar" },
        deserializeStackLength: 0,
        nodesTraversed: ["start", "process"],
      },
      globals: {
        store: {
          "main.agency": { greeting: "hi" },
          "helpers.agency": { cache: [1, 2, 3] },
        },
        initializedModules: ["main.agency", "helpers.agency"],
      },
    });
    writer.writeCheckpoint(cp);


    const reader = TraceReader.fromFile(tracePath);
    const reconstructed = reader.checkpoints[0];
    expect(reconstructed.stack.stack).toEqual(cp.stack.stack);
    expect(reconstructed.stack.mode).toBe("serialize");
    expect(reconstructed.stack.nodesTraversed).toEqual(["start", "process"]);
    expect(reconstructed.globals.store).toEqual(cp.globals.store);
    expect(reconstructed.globals.initializedModules).toEqual(["main.agency", "helpers.agency"]);
    expect(reconstructed.nodeId).toBe("process");
  });

  it("reads a trace with no checkpoints", () => {
    const fd = fs.openSync(tracePath, "w");
    fs.writeSync(fd, JSON.stringify({
      type: "header", version: 1, agencyVersion: "0.0.0",
      program: "test.agency",
      timestamp: new Date().toISOString(), config: { hashAlgorithm: "sha256" },
    }) + "\n");
    fs.closeSync(fd);

    const reader = TraceReader.fromFile(tracePath);
    expect(reader.checkpoints).toHaveLength(0);
  });

  it("has empty sources for plain trace files", () => {
    writeSimpleTrace(1);
    const reader = TraceReader.fromFile(tracePath);
    expect(reader.sources).toEqual({});
  });

  it("collects source lines into the sources property", () => {
    const fd = fs.openSync(tracePath, "w");
    fs.writeSync(fd, JSON.stringify({
      type: "header", version: 1, program: "main.agency",
      timestamp: new Date().toISOString(), config: { hashAlgorithm: "sha256" },
      bundle: true,
    }) + "\n");
    fs.writeSync(fd, JSON.stringify({
      type: "source", path: "main.agency", content: "node main() {\n  x = 1\n}",
    }) + "\n");
    fs.writeSync(fd, JSON.stringify({
      type: "source", path: "helpers.agency", content: "function add(a, b) {\n  return a + b\n}",
    }) + "\n");
    fs.closeSync(fd);

    const reader = TraceReader.fromFile(tracePath);
    expect(reader.sources).toEqual({
      "main.agency": "node main() {\n  x = 1\n}",
      "helpers.agency": "function add(a, b) {\n  return a + b\n}",
    });
    expect(reader.header.bundle).toBe(true);
  });

  it("writeSourcesToDisk extracts source files to a directory", () => {
    const fd = fs.openSync(tracePath, "w");
    fs.writeSync(fd, JSON.stringify({
      type: "header", version: 1, program: "main.agency",
      timestamp: new Date().toISOString(), config: { hashAlgorithm: "sha256" },
      bundle: true,
    }) + "\n");
    fs.writeSync(fd, JSON.stringify({
      type: "source", path: "main.agency", content: "node main() {\n  x = 1\n}",
    }) + "\n");
    fs.writeSync(fd, JSON.stringify({
      type: "source", path: "lib/helpers.agency", content: "function add(a, b) {}",
    }) + "\n");
    fs.closeSync(fd);

    const reader = TraceReader.fromFile(tracePath);
    const outDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(outDir);
    reader.writeSourcesToDisk(outDir);

    expect(fs.readFileSync(path.join(outDir, "main.agency"), "utf-8")).toBe("node main() {\n  x = 1\n}");
    expect(fs.readFileSync(path.join(outDir, "lib/helpers.agency"), "utf-8")).toBe("function add(a, b) {}");
  });
});
