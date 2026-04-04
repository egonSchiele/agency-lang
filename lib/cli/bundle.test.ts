import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBundle } from "./bundle.js";
import { TraceWriter } from "@/runtime/trace/traceWriter.js";
import { TraceReader } from "@/runtime/trace/traceReader.js";
import { Checkpoint } from "@/runtime/state/checkpointStore.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("createBundle", () => {
  let tmpDir: string;
  let tracePath: string;
  let bundlePath: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
    tracePath = path.join(tmpDir, "test.trace");
    bundlePath = path.join(tmpDir, "test.bundle");
    sourceDir = path.join(tmpDir, "src");
    fs.mkdirSync(sourceDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTestTrace() {
    const writer = new TraceWriter(tracePath, "main.agency");
    writer.writeCheckpoint(new Checkpoint({
      id: 0,
      nodeId: "main",
      moduleId: "main.agency",
      scopeName: "main",
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { x: 1 }, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
      globals: {
        store: { "main.agency": {} },
        initializedModules: ["main.agency"],
      },
    }));
  }

  function writeTestSource() {
    fs.writeFileSync(
      path.join(sourceDir, "main.agency"),
      "node main() {\n  x = 1\n  return x\n}\n",
    );
  }

  it("creates a bundle with header, sources, and trace data", () => {
    writeTestTrace();
    writeTestSource();

    createBundle(path.join(sourceDir, "main.agency"), tracePath, bundlePath);

    const reader = TraceReader.fromFile(bundlePath);
    expect(reader.header.bundle).toBe(true);
    expect(reader.sources["main.agency"]).toContain("node main()");
    expect(reader.checkpoints.length).toBe(1);
  });

  it("preserves checkpoint data from the original trace", () => {
    writeTestTrace();
    writeTestSource();

    createBundle(path.join(sourceDir, "main.agency"), tracePath, bundlePath);

    const reader = TraceReader.fromFile(bundlePath);
    const cp = reader.checkpoints[0];
    expect(cp.nodeId).toBe("main");
    expect(cp.stack.stack[0].locals.x).toBe(1);
  });

  it("throws if trace file does not exist", () => {
    writeTestSource();
    expect(() => createBundle(
      path.join(sourceDir, "main.agency"),
      path.join(tmpDir, "nonexistent.trace"),
      bundlePath,
    )).toThrow();
  });

  it("throws if source file does not exist", () => {
    writeTestTrace();
    expect(() => createBundle(
      path.join(sourceDir, "nonexistent.agency"),
      tracePath,
      bundlePath,
    )).toThrow();
  });
});
