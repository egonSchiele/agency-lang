import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { TraceReader } from "../runtime/trace/traceReader.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { DebuggerDriver } from "./driver.js";
import type { DebuggerCommand } from "./types.js";
import { isInterrupt } from "../runtime/interrupts.js";
import { TestDebuggerIO, fixtureDir } from "./testHelpers.js";
const traceTestAgency = path.join(fixtureDir, "trace-test.agency");
const traceTestCompiled = path.join(fixtureDir, "trace-test.ts");
const traceFile = path.join(fixtureDir, "trace-test.agencytrace");

describe("Trace integration with debugger", () => {
  let mod: any;

  beforeAll(async () => {
    compile(
      { debugger: true, trace: true, traceFile },
      traceTestAgency,
      traceTestCompiled,
      { ts: true },
    );
    mod = await import(traceTestCompiled);
  });

  afterAll(() => {
    for (const f of [traceTestCompiled, traceFile]) {
      try { fs.unlinkSync(f); } catch { }
    }
  });

  it("produces a trace file when running with trace enabled", async () => {
    const commands: DebuggerCommand[] = Array(20).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);

    const driver = new DebuggerDriver({
      mod: {
        approveInterrupt: mod.approveInterrupt,
        respondToInterrupt: mod.respondToInterrupt,
        rewindFrom: mod.rewindFrom,
        __setDebugger: mod.__setDebugger,
        __getCheckpoints: mod.__getCheckpoints,
      },
      sourceMap: mod.__sourceMap ?? {},
      rewindSize: 30,
      ui: testUI,
    });
    mod.__setDebugger(driver.debuggerState);

    const callbacks = driver.getCallbacks();
    const initialResult = await mod.main({ callbacks });
    expect(isInterrupt(initialResult.data)).toBe(true);
    await driver.run(initialResult, { interceptConsole: false });

    // Verify trace file was created
    expect(fs.existsSync(traceFile)).toBe(true);

    // Read and validate the trace
    const reader = TraceReader.fromFile(traceFile);
    expect(reader.checkpoints.length).toBeGreaterThan(0);

    // Verify each checkpoint is a valid Checkpoint instance
    for (const cp of reader.checkpoints) {
      expect(cp).toBeInstanceOf(Checkpoint);
      expect(cp.stack.stack.length).toBeGreaterThan(0);
    }

    // Verify state progresses: later checkpoints should have more locals
    const firstCp = reader.checkpoints[0];
    const lastCp = reader.checkpoints[reader.checkpoints.length - 1];
    const firstLocals = firstCp.stack.stack[firstCp.stack.stack.length - 1].locals;
    const lastLocals = lastCp.stack.stack[lastCp.stack.stack.length - 1].locals;

    // The last checkpoint should have c = 30 (a=10, b=20, c=a+b)
    expect(lastLocals.c).toBe(30);
    expect(Object.keys(lastLocals).length).toBeGreaterThanOrEqual(Object.keys(firstLocals).length);
  });

  it("deduplicates globals across trace checkpoints", () => {
    // Read the trace file from the previous test
    const content = fs.readFileSync(traceFile, "utf-8");
    const lines = content.trim().split("\n").map((l: string) => JSON.parse(l));
    const chunks = lines.filter((l: any) => l.type === "chunk");
    const manifests = lines.filter((l: any) => l.type === "manifest");

    // With deduplication, should have fewer chunks than manifests * 2
    expect(chunks.length).toBeLessThan(manifests.length * 2);
  });
});
