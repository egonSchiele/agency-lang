import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _finalizeInput,
  _finishEvalRun,
  _formatEvalRunFailure,
  _initEvalRun,
  _evalJudgeSuite,
  _optimize,
  _prepareInput,
} from "./agencyEval.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";

describe("agency eval stdlib helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-stdlib-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes runs with generated ids and reports prepare failures", () => {
    const state = _initEvalRun(
      { moduleId: "agent" },
      [{ id: "../escape", goal: "g", args: {} }],
      "main",
      tmpDir,
      "",
      true,
    );
    expect(state.runId).not.toBe("");

    const prep = _prepareInput(state, state.inputs[0]);
    expect(prep.ok).toBe(false);
    if (!prep.ok) {
      expect(prep.result).toMatchObject({
        inputId: "../escape",
        status: "error",
      });
    }

    const summary = _finishEvalRun(state, prep.ok ? [] : [prep.result]);
    expect(summary.errorCount).toBe(1);
    expect(fs.existsSync(path.join(state.runDir, "summary.json"))).toBe(true);
  });

  it("finalizes prepared inputs with success or error results", async () => {
    const state = _initEvalRun(
      { moduleId: "agent" },
      [{ id: "t1", goal: "g", args: {} }],
      "main",
      tmpDir,
      "r1",
      true,
    );
    const prep = _prepareInput(state, state.inputs[0]);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // No statelog file written → finalize skips extraction and succeeds.
    const success = await _finalizeInput(prep.prepared, "");
    const error = await _finalizeInput(prep.prepared, "boom");

    expect(success).toMatchObject({ inputId: "t1", status: "success" });
    expect(error).toMatchObject({ inputId: "t1", status: "error", errorMessage: "boom" });
  });

  it("formats failure-like values", () => {
    expect(_formatEvalRunFailure({ value: { message: "limit" } })).toBe("limit");
    expect(_formatEvalRunFailure({ error: { message: "boom" } })).toBe("boom");
    expect(_formatEvalRunFailure("plain")).toBe("plain");
  });

  it("delegates suite judging to the core judgeSuite helper", async () => {
    const result = await _evalJudgeSuite(
      "run-a",
      "run-b",
      [{ id: "task-1", goal: "g", args: {} }],
      5,
      60,
      1,
      "none",
      async (args) => ({
        verdictVersion: 2,
        generatedAt: "2026-06-11T00:00:00.000Z",
        policy: args.policy,
        winsA: 0,
        winsB: 1,
        ties: 0,
        winner: "B",
        perInput: [],
      }),
    );

    expect(result).toMatchObject({
      winner: "B",
      policy: { samples: 5, confidenceThreshold: 60, marginThreshold: 1, positionBias: "none" },
    });
  });

  it("delegates optimize requests to the core loop without installing handlers", async () => {
    let loopConfig: OptimizeLoopConfig | null = null;
    const entryFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(entryFile, "optimize const prompt = \"hi\"\nnode main() {}\n");

    const result = await _optimize(
      {},
      entryFile,
      tmpDir,
      "main",
      [{ id: "t1", goal: "g", args: {} }],
      "",
      2,
      3,
      60,
      1,
      tmpDir,
      "run",
      "mutator",
      false,
      "silent",
      async (config) => {
        loopConfig = config;
        return optimizeResult(config);
      },
    );

    expect(loopConfig).toMatchObject({
      runtime: {
        inputs: [{ id: "t1", goal: "g", args: {} }],
        inputsSource: "stdlib:inputs",
      },
      target: {
        node: "main",
        entryFile: "agent.agency",
        writeback: false,
      },
      policy: {
        iterations: 2,
        mutatorModel: "mutator",
      },
      judgePolicy: {
        samples: 3,
        confidenceThreshold: 60,
        marginThreshold: 1,
        positionBias: "swap",
      },
      artifacts: {
        runsDir: tmpDir,
        runId: "run",
      },
    });
    if (!loopConfig) throw new Error("loop was not called");
    expect((loopConfig as OptimizeLoopConfig).target.targetSet.targets.map((target) => target.id)).toEqual([
      "agent.agency:global:prompt",
    ]);
    expect(result).toMatchObject({ runId: "run", championIter: "baseline" });
  });

  it("desugars a goal into a single input-1 input", async () => {
    let loopConfig: OptimizeLoopConfig | null = null;
    const entryFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(entryFile, "optimize const prompt = \"hi\"\nnode main() {}\n");

    await _optimize(
      {},
      entryFile,
      tmpDir,
      "main",
      [],
      "improve",
      2,
      3,
      50,
      0,
      tmpDir,
      "run",
      "",
      false,
      "silent",
      async (config) => {
        loopConfig = config;
        return optimizeResult(config);
      },
    );

    expect(loopConfig).toMatchObject({
      runtime: {
        inputs: [{ id: "input-1", goal: "improve", args: {} }],
        inputsSource: "inline:goal",
      },
    });
  });

  it("requires exactly one of inputs or goal", async () => {
    const entryFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(entryFile, "optimize const prompt = \"hi\"\nnode main() {}\n");
    const reject = (inputs: { id: string; goal: string; args: Record<string, unknown> }[], goal: string) =>
      _optimize({}, entryFile, tmpDir, "main", inputs, goal, 1, 1, 50, 0, tmpDir, "run", "", false, "silent", async (config) => optimizeResult(config));

    await expect(reject([], "")).rejects.toThrow(/exactly one of --tasks or --goal/i);
    await expect(reject([{ id: "t1", goal: "g", args: {} }], "both")).rejects.toThrow(/exactly one of --tasks or --goal/i);
  });

  it("rejects unknown verbosity values", async () => {
    const entryFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(entryFile, "optimize const prompt = \"hi\"\nnode main() {}\n");

    await expect(
      _optimize({}, entryFile, tmpDir, "main", [{ id: "t1", goal: "g", args: {} }], "", 1, 1, 50, 0, tmpDir, "run", "", false, "loud", async (config) => optimizeResult(config)),
    ).rejects.toThrow(/verbosity must be/);
  });

  it("resolves relative entry files against the stdlib working directory", async () => {
    let loopConfig: OptimizeLoopConfig | null = null;
    fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
    const entryFile = path.join(tmpDir, "agents", "agent.agency");
    fs.writeFileSync(entryFile, "optimize const prompt = \"hi\"\nnode main() {}\n");

    await _optimize(
      {},
      "agents/agent.agency",
      tmpDir,
      "main",
      [{ id: "t1", goal: "g", args: {} }],
      "",
      2,
      3,
      50,
      0,
      tmpDir,
      "run",
      "",
      false,
      "silent",
      async (config) => {
        loopConfig = config;
        return optimizeResult(config);
      },
    );

    if (!loopConfig) throw new Error("loop was not called");
    const config = loopConfig as OptimizeLoopConfig;
    expect(config.target.targetSet.files[config.target.entryFile].absoluteFile).toBe(fs.realpathSync(entryFile));
  });
});

function optimizeResult(config: OptimizeLoopConfig): OptimizeResult {
  return {
    runId: config.artifacts.runId,
    runDir: path.join(config.artifacts.runsDir, config.artifacts.runId),
    championIter: "baseline",
    championFiles: {},
    acceptedCount: 0,
    rejectedCount: 0,
    validationFailedCount: 0,
    iterations: [],
  };
}
