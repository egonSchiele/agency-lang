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
    fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
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
      agent: "agent.agency:main",
      inputs,
      okCount: inputs.filter((input) => input.status === "success").length,
      errorCount: inputs.filter((input) => input.status === "error").length,
    }, null, 2));
  }

  function writeInput(inputId: string, input: unknown): void {
    fs.mkdirSync(path.join(runDir, "tasks", inputId), { recursive: true });
    fs.writeFileSync(path.join(runDir, "tasks", inputId, "task.json"), JSON.stringify(input, null, 2));
  }

  function writeRecord(inputId: string, record: unknown): void {
    fs.mkdirSync(path.join(runDir, "tasks", inputId), { recursive: true });
    fs.writeFileSync(recordPath(inputId), JSON.stringify(record, null, 2));
  }

  function writeError(inputId: string, message: string): void {
    fs.mkdirSync(path.join(runDir, "tasks", inputId), { recursive: true });
    fs.writeFileSync(path.join(runDir, "tasks", inputId, "error.txt"), message);
  }

  function recordPath(inputId: string): string {
    return path.join(runDir, "tasks", inputId, "eval-record.json");
  }
});
