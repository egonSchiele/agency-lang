import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { shouldExtractStatelog } from "./run/extract.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initializeEvalRun,
  prepareInput,
  recordInputPrepareFailure,
  writeEvalRunSummary,
} from "./runArtifacts.js";

describe("eval run artifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-artifacts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes a run directory with config", () => {
    const state = initializeEvalRun({
      runId: "r1",
      runsDir: tmpDir,
      agentLabel: "agent.agency:main",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    });

    expect(fs.existsSync(path.join(tmpDir, "r1", "inputs"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "r1", "config.json"), "utf-8"))).toMatchObject({
      runId: "r1",
      agentLabel: "agent.agency:main",
      continueOnError: true,
      startedAt: "2026-06-09T14:30:00.000Z",
    });
    expect(state.runDir).toBe(path.join(tmpDir, "r1"));
  });

  it("rejects existing run directories before writing partial state", () => {
    fs.mkdirSync(path.join(tmpDir, "existing"), { recursive: true });

    expect(() => initializeEvalRun({
      runId: "existing",
      runsDir: tmpDir,
      agentLabel: "agent.agency:main",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    })).toThrow(
      `Run directory already exists: ${path.join(tmpDir, "existing")}.
Choose a different --run-id or delete the existing directory.`,
    );

    expect(fs.existsSync(path.join(tmpDir, "existing", "inputs"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "existing", "config.json"))).toBe(false);
  });

  it("prepares per-input artifact paths but leaves workdir to prepareRunDir", () => {
    const state = initializeState();

    const prepared = prepareInput(state, { id: "t1", goal: "goal", task: "t" });

    expect(JSON.parse(fs.readFileSync(path.join(state.runDir, "inputs", "t1", "input.json"), "utf-8"))).toMatchObject({ id: "t1", goal: "goal" });
    // prepareInput allocates the path but no longer creates the workdir — that's
    // prepareRunDir's job (seed + overlay + compile inside the workdir).
    expect(fs.existsSync(prepared.workdirPath)).toBe(false);
    expect(prepared.statelogPath).toBe(path.join(state.runDir, "inputs", "t1", "agent", "statelog.jsonl"));
    expect(prepared.evalRecordPath).toBe(path.join(state.runDir, "inputs", "t1", "agent", "eval-record.json"));
  });

  it("rejects run ids that escape the runs directory", () => {
    expect(() => initializeEvalRun({
      runId: "../escape",
      runsDir: tmpDir,
      agentLabel: "agent.agency:main",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    })).toThrow("Invalid runId");
  });

  it("rejects input ids that escape the input directory", () => {
    const state = initializeState();

    expect(() => prepareInput(state, { id: "../escape", goal: "goal", task: "t" })).toThrow("Invalid id");
  });

  it("records prepare failures without touching artifact paths", () => {
    const result = recordInputPrepareFailure("t1", "invalid id");

    expect(result).toEqual({
      inputId: "t1",
      status: "error",
      evalRecordPath: "",
      statelogPath: "",
      workdirPath: "",
      errorMessage: "invalid id",
    });
  });

  it("extracts only when statelog exists and is non-empty", () => {
    const statelog = path.join(tmpDir, "statelog.jsonl");

    expect(shouldExtractStatelog(statelog)).toBe(false);
    fs.writeFileSync(statelog, "");
    expect(shouldExtractStatelog(statelog)).toBe(false);
    fs.writeFileSync(statelog, "{}\n");
    expect(shouldExtractStatelog(statelog)).toBe(true);
  });

  describe("writeEvalRunSummary metrics", () => {
    it("copies a metrics block from each eval record, including the agent name", () => {
      const state = initializeState();
      const prepared = prepareInput(state, { id: "t1", goal: "g", task: "t" });
      fs.mkdirSync(path.dirname(prepared.evalRecordPath), { recursive: true });
      fs.writeFileSync(prepared.evalRecordPath, JSON.stringify({
        durationMs: 120_000,
        startedAtMs: 1_754_000_000_000,
        agentName: "gcode",
        metrics: { costUsdTotal: 1.25, models: ["sonnet"] },
      }));

      const summary = writeEvalRunSummary(state, [inputResult(prepared, "success")]);

      expect(summary.inputs[0].metrics).toEqual({
        costUsd: 1.25,
        durationMs: 120_000,
        startedAtMs: 1_754_000_000_000,
        models: ["sonnet"],
        agentName: "gcode",
      });
    });

    it("omits agentName when the record has none", () => {
      const state = initializeState();
      const prepared = prepareInput(state, { id: "t1", goal: "g", task: "t" });
      fs.mkdirSync(path.dirname(prepared.evalRecordPath), { recursive: true });
      fs.writeFileSync(prepared.evalRecordPath, JSON.stringify({
        durationMs: 5, startedAtMs: 10, metrics: { costUsdTotal: 0, models: [] },
      }));

      const summary = writeEvalRunSummary(state, [inputResult(prepared, "success")]);

      expect(summary.inputs[0].metrics).toBeDefined();
      expect(summary.inputs[0].metrics).not.toHaveProperty("agentName");
    });

    it("leaves metrics absent for a missing record without warning", () => {
      const state = initializeState();
      const prepared = prepareInput(state, { id: "t1", goal: "g", task: "t" });
      const warnings: string[] = [];

      const summary = writeEvalRunSummary(state, [inputResult(prepared, "error")], (m) => warnings.push(m));

      expect(summary.inputs[0].metrics).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it("a parseable record with a wrong shape leaves metrics absent with a warning", () => {
      const state = initializeState();
      const prepared = prepareInput(state, { id: "t1", goal: "g", task: "t" });
      fs.mkdirSync(path.dirname(prepared.evalRecordPath), { recursive: true });
      fs.writeFileSync(prepared.evalRecordPath, JSON.stringify({
        durationMs: "not-a-number", startedAtMs: 10,
        metrics: { costUsdTotal: 1.0, models: ["sonnet"] },
      }));
      const warnings: string[] = [];

      const summary = writeEvalRunSummary(state, [inputResult(prepared, "success")], (m) => warnings.push(m));

      expect(summary.inputs[0].metrics).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("unexpected shape");
    });

    it("warns on a malformed record but still writes the summary", () => {
      const state = initializeState();
      const prepared = prepareInput(state, { id: "t1", goal: "g", task: "t" });
      fs.mkdirSync(path.dirname(prepared.evalRecordPath), { recursive: true });
      fs.writeFileSync(prepared.evalRecordPath, "{ torn");
      const warnings: string[] = [];

      const summary = writeEvalRunSummary(state, [inputResult(prepared, "success")], (m) => warnings.push(m));

      expect(summary.inputs[0].metrics).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(prepared.evalRecordPath);
      expect(fs.existsSync(path.join(state.runDir, "summary.json"))).toBe(true);
    });
  });

  function inputResult(prepared: { input: { id?: string }; evalRecordPath: string; statelogPath: string; workdirPath: string }, status: "success" | "error") {
    return {
      inputId: prepared.input.id ?? "t1",
      status,
      evalRecordPath: prepared.evalRecordPath,
      statelogPath: prepared.statelogPath,
      workdirPath: prepared.workdirPath,
    };
  }

  function initializeState() {
    return initializeEvalRun({
      runId: "r1",
      runsDir: tmpDir,
      agentLabel: "agent.agency:main",
      inputs: [],
      continueOnError: true,
      startedAt: new Date("2026-06-09T14:30:00.000Z"),
    });
  }
});
