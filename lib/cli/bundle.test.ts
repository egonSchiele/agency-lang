import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBundle, extractBundle } from "./bundle.js";
import { TraceWriter } from "@/runtime/trace/traceWriter.js";
import { FileSink } from "@/runtime/trace/sinks.js";
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

  async function writeTestTrace() {
    const writer = new TraceWriter("main.agency", [new FileSink(tracePath)]);
    await writer.writeCheckpoint(new Checkpoint({
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
    await writer.close();
  }

  function writeTestSource() {
    fs.writeFileSync(
      path.join(sourceDir, "main.agency"),
      "node main() {\n  x = 1\n  return x\n}\n",
    );
  }

  it("creates a bundle with header, sources, and trace data", async () => {
    await writeTestTrace();
    writeTestSource();

    createBundle(path.join(sourceDir, "main.agency"), tracePath, bundlePath);

    const reader = TraceReader.fromFile(bundlePath);
    expect(reader.header.bundle).toBe(true);
    expect(reader.sources["main.agency"]).toContain("node main()");
    expect(reader.checkpoints.length).toBe(1);
  });

  it("preserves checkpoint data from the original trace", async () => {
    await writeTestTrace();
    writeTestSource();

    createBundle(path.join(sourceDir, "main.agency"), tracePath, bundlePath);

    const reader = TraceReader.fromFile(bundlePath);
    const cp = reader.checkpoints[0];
    expect(cp.nodeId).toBe("main");
    expect(cp.stack.stack[0].locals.x).toBe(1);
  });

  it("throws if trace file does not exist", async () => {
    writeTestSource();
    expect(() => createBundle(
      path.join(sourceDir, "main.agency"),
      path.join(tmpDir, "nonexistent.trace"),
      bundlePath,
    )).toThrow();
  });

  it("throws if source file does not exist", async () => {
    await writeTestTrace();
    expect(() => createBundle(
      path.join(sourceDir, "nonexistent.agency"),
      tracePath,
      bundlePath,
    )).toThrow();
  });
});

describe("extractBundle", () => {
  let tmpDir: string;
  let tracePath: string;
  let bundlePath: string;
  let sourceDir: string;
  let outDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
    tracePath = path.join(tmpDir, "test.trace");
    bundlePath = path.join(tmpDir, "test.bundle");
    sourceDir = path.join(tmpDir, "src");
    outDir = path.join(tmpDir, "out");
    fs.mkdirSync(sourceDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeTestTrace() {
    const writer = new TraceWriter("main.agency", [new FileSink(tracePath)]);
    await writer.writeCheckpoint(new Checkpoint({
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
    await writer.close();
  }

  function writeTestSource() {
    fs.writeFileSync(
      path.join(sourceDir, "main.agency"),
      "node main() {\n  x = 1\n  return x\n}\n",
    );
  }

  async function createTestBundle() {
    await writeTestTrace();
    writeTestSource();
    createBundle(path.join(sourceDir, "main.agency"), tracePath, bundlePath);
  }

  it("extracts source files and trace from a bundle", async () => {
    await createTestBundle();

    extractBundle(bundlePath, outDir);

    expect(fs.existsSync(path.join(outDir, "main.agency"))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "main.agency"), "utf-8")).toContain("node main()");
    expect(fs.existsSync(path.join(outDir, "main.trace"))).toBe(true);
  });

  it("produces a valid trace file", async () => {
    await createTestBundle();

    extractBundle(bundlePath, outDir);

    const reader = TraceReader.fromFile(path.join(outDir, "main.trace"));
    expect(reader.checkpoints.length).toBe(1);
    expect(reader.checkpoints[0].nodeId).toBe("main");
  });

  it("throws on empty bundle file", () => {
    fs.writeFileSync(bundlePath, "");
    expect(() => extractBundle(bundlePath, outDir)).toThrow("empty");
  });

  it("throws on absolute source path", () => {
    const malicious = [
      JSON.stringify({ program: "main.agency" }),
      JSON.stringify({ type: "source", path: "/etc/passwd", content: "bad" }),
    ].join("\n");
    fs.writeFileSync(bundlePath, malicious);

    expect(() => extractBundle(bundlePath, outDir)).toThrow("absolute paths not allowed");
  });

  it("throws on path traversal in source path", () => {
    const malicious = [
      JSON.stringify({ program: "main.agency" }),
      JSON.stringify({ type: "source", path: "../../escape.txt", content: "bad" }),
    ].join("\n");
    fs.writeFileSync(bundlePath, malicious);

    expect(() => extractBundle(bundlePath, outDir)).toThrow("escapes target directory");
  });
});
