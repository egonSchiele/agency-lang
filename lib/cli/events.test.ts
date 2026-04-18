import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TraceWriter } from "../runtime/trace/traceWriter.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { traceLog } from "./events.js";

describe("traceLog integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates event log from trace file and writes to output", () => {
    const tracePath = path.join(tmpDir, "test.agencytrace");
    const outputPath = path.join(tmpDir, "events.json");

    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(
      new Checkpoint({
        id: 0,
        nodeId: "main",
        moduleId: "test.agency",
        scopeName: "main",
        stepPath: "0",
        label: null,
        pinned: false,
        stack: {
          stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
          mode: "serialize" as const,
          other: {},
          deserializeStackLength: 0,
          nodesTraversed: ["main"],
        },
        globals: {
          store: { "test.agency": {} },
          initializedModules: ["test.agency"],
        },
      }),
    );
    writer.writeCheckpoint(
      new Checkpoint({
        id: 1,
        nodeId: "main",
        moduleId: "test.agency",
        scopeName: "main",
        stepPath: "1",
        label: null,
        pinned: false,
        stack: {
          stack: [
            {
              args: {},
              locals: { greeting: "hello" },
              threads: null,
              step: 1,
            },
          ],
          mode: "serialize" as const,
          other: {},
          deserializeStackLength: 0,
          nodesTraversed: ["main"],
        },
        globals: {
          store: { "test.agency": {} },
          initializedModules: ["test.agency"],
        },
      }),
    );

    traceLog(tracePath, outputPath);

    const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(0);

    const types = output.map((e: any) => e.type);
    expect(types).toContain("node-enter");
    expect(types).toContain("variable-set");

    const varEvent = output.find((e: any) => e.type === "variable-set");
    expect(varEvent.variable).toBe("greeting");
    expect(varEvent.value).toBe("hello");
  });

  it("handles empty trace (no checkpoints)", () => {
    const tracePath = path.join(tmpDir, "empty.agencytrace");
    const outputPath = path.join(tmpDir, "events.json");

    // TraceWriter writes header on construction; no checkpoints added
    new TraceWriter(tracePath, "test.agency");

    traceLog(tracePath, outputPath);

    const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(output).toEqual([]);
  });
});
