import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEvalRun } from "./readRun.js";

describe("readEvalRun", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-read-run-"));
    runDir = path.join(tmpDir, "run-a");
    fs.mkdirSync(path.join(runDir, "inputs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes successful input records by input id", () => {
    writeInput("task-1", { id: "task-1", goal: "Return Paris", args: {} });
    writeRecord("task-1", { recordVersion: 2, evalOutputs: [{ value: "Paris", tMs: 1 }] });
    writeSummary([{ inputId: "task-1", status: "success", evalRecordPath: recordPath("task-1"), statelogPath: "", workdirPath: "" }]);

    const run = readEvalRun(runDir);

    expect(run.runDir).toBe(runDir);
    expect(run.inputsById["task-1"]).toMatchObject({
      inputId: "task-1",
      input: { id: "task-1", goal: "Return Paris", args: {} },
      recordPath: recordPath("task-1"),
      status: "ok",
    });
  });

  it("marks successful summary inputs with missing eval records as missing", () => {
    writeInput("missing-record", { id: "missing-record", goal: "Return Paris", args: {} });
    writeSummary([{ inputId: "missing-record", status: "success", evalRecordPath: recordPath("missing-record"), statelogPath: "", workdirPath: "" }]);

    expect(readEvalRun(runDir).inputsById["missing-record"]).toMatchObject({
      inputId: "missing-record",
      status: "missing",
      recordPath: recordPath("missing-record"),
    });
  });

  it("marks failed summary inputs as failed and reads error text", () => {
    writeInput("failed", { id: "failed", goal: "Return Paris", args: {} });
    writeError("failed", "boom");
    writeSummary([{ inputId: "failed", status: "error", evalRecordPath: recordPath("failed"), statelogPath: "", workdirPath: "", errorMessage: "summary boom" }]);

    expect(readEvalRun(runDir).inputsById.failed).toMatchObject({
      inputId: "failed",
      status: "failed",
      errorMessage: "boom",
    });
  });

  it("degrades a corrupt input.json to no spec instead of failing the whole load", () => {
    writeRecord("task-1", { recordVersion: 2, evalOutputs: [{ value: "Paris", tMs: 1 }] });
    fs.writeFileSync(path.join(runDir, "inputs", "task-1", "input.json"), "{not json");
    writeSummary([{ inputId: "task-1", status: "success", evalRecordPath: recordPath("task-1"), statelogPath: "", workdirPath: "" }]);

    const run = readEvalRun(runDir);

    expect(run.inputsById["task-1"].status).toBe("ok");
    expect(run.inputsById["task-1"].input).toBeUndefined();
  });

  it("ignores input directories that are not present in summary.json", () => {
    writeInput("task-1", { id: "task-1", goal: "Return Paris", args: {} });
    writeRecord("task-1", { recordVersion: 2, evalOutputs: [{ value: "Paris", tMs: 1 }] });
    writeInput("extra", { id: "extra", goal: "Ignore me", args: {} });
    writeRecord("extra", { recordVersion: 2, evalOutputs: [{ value: "extra", tMs: 1 }] });
    writeSummary([{ inputId: "task-1", status: "success", evalRecordPath: recordPath("task-1"), statelogPath: "", workdirPath: "" }]);

    expect(Object.keys(readEvalRun(runDir).inputsById)).toEqual(["task-1"]);
  });

  function writeSummary(inputs: any[]): void {
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
      runId: "run-a",
      runDir,
      agentLabel: "agent.agency:main",
      inputs,
      okCount: inputs.filter((input) => input.status === "success").length,
      errorCount: inputs.filter((input) => input.status === "error").length,
    }, null, 2));
  }

  function writeInput(inputId: string, input: unknown): void {
    fs.mkdirSync(path.join(runDir, "inputs", inputId), { recursive: true });
    fs.writeFileSync(path.join(runDir, "inputs", inputId, "input.json"), JSON.stringify(input, null, 2));
  }

  function writeRecord(inputId: string, record: unknown): void {
    fs.mkdirSync(path.join(runDir, "inputs", inputId), { recursive: true });
    fs.writeFileSync(recordPath(inputId), JSON.stringify(record, null, 2));
  }

  function writeError(inputId: string, message: string): void {
    fs.mkdirSync(path.join(runDir, "inputs", inputId, "agent"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "inputs", inputId, "agent", "error.txt"), message);
  }

  function recordPath(inputId: string): string {
    return path.join(runDir, "inputs", inputId, "eval-record.json");
  }
});

describe("readEvalRun layouts", () => {
  function makeLayoutRun(layout: "legacy" | "current"): string {
    const layoutRunDir = fs.mkdtempSync(path.join(os.tmpdir(), "readrun-"));
    const inputDir = path.join(layoutRunDir, "inputs", "a");
    const recordDir = layout === "current" ? path.join(inputDir, "agent") : inputDir;
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, "eval-record.json"), JSON.stringify({ evalOutputs: [] }));
    fs.writeFileSync(path.join(layoutRunDir, "summary.json"), JSON.stringify({
      runId: "r", runDir: layoutRunDir, agentLabel: "a:main", okCount: 1, errorCount: 0,
      // Empty evalRecordPath forces the constructed-path fallback — the only
      // layout-sensitive code path.
      inputs: [{ inputId: "a", status: "success", evalRecordPath: "", statelogPath: "", workdirPath: "" }],
    }));
    return layoutRunDir;
  }

  it("finds the record under agent/ (current layout)", () => {
    const layoutRunDir = makeLayoutRun("current");
    expect(readEvalRun(layoutRunDir).inputsById["a"].status).toBe("ok");
    fs.rmSync(layoutRunDir, { recursive: true, force: true });
  });

  it("the pre-#733 flat layout is no longer read: such a run loads as missing", () => {
    const layoutRunDir = makeLayoutRun("legacy");
    expect(readEvalRun(layoutRunDir).inputsById["a"].status).toBe("missing");
    fs.rmSync(layoutRunDir, { recursive: true, force: true });
  });
});
