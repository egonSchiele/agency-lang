import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { TraceReader } from "../runtime/trace/traceReader.js";
import { TraceWriter } from "../runtime/trace/traceWriter.js";
import { FileSink } from "../runtime/trace/sinks.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { DebuggerDriver } from "./driver.js";
import type { DebuggerCommand } from "./types.js";
import { isInterrupt } from "../runtime/interrupts.js";
import { TestDebuggerIO, fixtureDir } from "./testHelpers.js";
const traceTestAgency = path.join(fixtureDir, "trace-test.agency");
const traceTestCompiled = path.join(fixtureDir, "trace-test.ts");
const traceFile = path.join(fixtureDir, "trace-test.agencytrace");

const RUN_ID = "trace-test-run-id";

describe("Trace integration with debugger", () => {
  let mod: any;

  beforeAll(async () => {
    compile({ debugger: true }, traceTestAgency, traceTestCompiled, {
      ts: true,
    });
    mod = await import(traceTestCompiled);
  });

  afterAll(() => {
    for (const f of [traceTestCompiled, traceFile]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  it.skip(
    "produces a trace file when running with trace enabled",
    { timeout: 15000 },
    async () => {
      console.log("[trace-test] Step 1: Creating TraceWriter");
      const traceWriter = new TraceWriter(RUN_ID, "trace-test.agency", [
        new FileSink(traceFile),
      ]);
      console.log("[trace-test] Step 2: Setting traceWriter on module");
      mod.__setTraceWriter(traceWriter);

      console.log("[trace-test] Step 3: Creating commands and TestDebuggerIO");
      const commands: DebuggerCommand[] = [
        ...Array(20).fill({ type: "step" }),
        { type: "continue" },
      ];
      const testUI = new TestDebuggerIO(commands);

      console.log("[trace-test] Step 4: Creating DebuggerDriver");
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
      console.log("[trace-test] Step 5: Setting debugger on module");
      mod.__setDebugger(driver.debuggerState);

      console.log("[trace-test] Step 6: Getting callbacks");
      const callbacks = driver.getCallbacks();
      console.log("[trace-test] Step 7: Calling mod.main()");
      const initialResult = await mod.main({ callbacks });
      console.log(
        "[trace-test] Step 8: mod.main() returned, checking interrupt",
      );
      expect(isInterrupt(initialResult.data)).toBe(true);

      console.log("[trace-test] Step 9: Starting driver.run()");
      await driver.run(initialResult, { interceptConsole: false });
      console.log("[trace-test] Step 10: driver.run() completed");

      console.log("[trace-test] Step 11: Closing traceWriter");
      await traceWriter.close();
      console.log("[trace-test] Step 12: traceWriter closed");

      // Verify trace file was created
      expect(fs.existsSync(traceFile)).toBe(true);
      console.log("[trace-test] Step 13: Trace file exists");

      // Read and validate the trace
      const reader = TraceReader.fromFile(traceFile);
      console.log(
        "[trace-test] Step 14: Read trace, checkpoints: " +
          reader.checkpoints.length,
      );
      expect(reader.checkpoints.length).toBeGreaterThan(0);

      // Verify each checkpoint is a valid Checkpoint instance
      for (const cp of reader.checkpoints) {
        expect(cp).toBeInstanceOf(Checkpoint);
        expect(cp.stack.stack.length).toBeGreaterThan(0);
      }
      console.log("[trace-test] Step 15: All checkpoints valid");

      // Verify state progresses: later checkpoints should have more locals
      const firstCp = reader.checkpoints[0];
      const lastCp = reader.checkpoints[reader.checkpoints.length - 1];
      const firstLocals =
        firstCp.stack.stack[firstCp.stack.stack.length - 1].locals;
      const lastLocals =
        lastCp.stack.stack[lastCp.stack.stack.length - 1].locals;

      console.log(
        "[trace-test] Step 16: firstLocals:",
        JSON.stringify(firstLocals),
      );
      console.log(
        "[trace-test] Step 17: lastLocals:",
        JSON.stringify(lastLocals),
      );

      // The last checkpoint should have c = 30 (a=10, b=20, c=a+b)
      expect(lastLocals.c).toBe(30);
      expect(Object.keys(lastLocals).length).toBeGreaterThanOrEqual(
        Object.keys(firstLocals).length,
      );
      console.log("[trace-test] Step 18: All assertions passed");
    },
  );

  it.skip("deduplicates globals across trace checkpoints", () => {
    // Read the trace file from the previous test
    const content = fs.readFileSync(traceFile, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l));
    const chunks = lines.filter((l: any) => l.type === "chunk");
    const manifests = lines.filter((l: any) => l.type === "manifest");

    // With deduplication, should have fewer chunks than manifests * 2
    expect(chunks.length).toBeLessThan(manifests.length * 2);
  });
});
