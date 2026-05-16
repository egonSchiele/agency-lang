import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { TraceReader } from "../runtime/trace/traceReader.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { DebuggerDriver } from "./driver.js";
import type { DebuggerCommand } from "./types.js";
import { hasInterrupts } from "../runtime/interrupts.js";
import { TestDebuggerIO, fixtureDir, freshImport } from "./testHelpers.js";

const traceTestAgency = path.join(fixtureDir, "trace-test.agency");
const traceTestCompiled = path.join(fixtureDir, "trace-test.ts");
const traceFile = path.join(fixtureDir, "trace-test.agencytrace");

describe("Trace integration with debugger", () => {
  let mod: any;

  beforeAll(async () => {
    compile({ debugger: true }, traceTestAgency, traceTestCompiled, {
      ts: true,
    });
    mod = await freshImport(traceTestCompiled);
  });

  afterAll(() => {
    for (const f of [traceTestCompiled, traceFile]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  it(
    "produces a trace file when running with trace enabled",
    { timeout: 15000 },
    async () => {
      // Reconfigure the global traceConfig.traceFile so each per-execCtx
      // TraceWriter created during the run will write (in append mode)
      // to this file. __setTraceFile truncates the file so the run starts
      // clean.
      mod.__setTraceFile(traceFile);

      const commands: DebuggerCommand[] = [
        ...Array(20).fill({ type: "step" }),
        { type: "continue" },
      ];
      const testUI = new TestDebuggerIO(commands);

      const driver = new DebuggerDriver({
        mod: {
          respondToInterrupts: mod.respondToInterrupts,
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
      expect(hasInterrupts(initialResult.data)).toBe(true);

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
      const firstLocals =
        firstCp.stack.stack[firstCp.stack.stack.length - 1].locals;
      const lastLocals =
        lastCp.stack.stack[lastCp.stack.stack.length - 1].locals;

      // The last checkpoint should have c = 30 (a=10, b=20, c=a+b)
      expect(lastLocals.c).toBe(30);
      expect(Object.keys(lastLocals).length).toBeGreaterThanOrEqual(
        Object.keys(firstLocals).length,
      );

      // Cross-segment trace optimizations:
      //   1. Exactly one `header` line spans the whole file (each new
      //      per-execCtx writer skips writing a header after detecting one
      //      already on disk via `scanExistingTraceFile`).
      //   2. Cross-segment chunk dedup happens — chunks observed on disk by
      //      a new writer seed its CAS so they aren't re-emitted. With many
      //      step-driven interrupts and shared globals/frames between
      //      segments, total chunks should be far less than 2× manifests
      //      (a loose-but-meaningful upper bound).
      const lines = fs
        .readFileSync(traceFile, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const headers = lines.filter((l: any) => l.type === "header");
      expect(headers).toHaveLength(1);

      const chunks = lines.filter((l: any) => l.type === "chunk");
      const manifests = lines.filter((l: any) => l.type === "manifest");
      expect(manifests.length).toBeGreaterThan(0);
      expect(chunks.length).toBeLessThan(manifests.length * 2);
    },
  );
});
