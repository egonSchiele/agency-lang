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

  it("indexes successful task records by task id", () => {
    writeTask("task-1", { task_id: "task-1", goal: "Return Paris", args: {} });
    writeRecord("task-1", { recordVersion: 2, evalOutputs: [{ value: "Paris", tMs: 1 }] });
    writeSummary([{ taskId: "task-1", status: "success", evalRecordPath: recordPath("task-1"), statelogPath: "", workdirPath: "" }]);

    const run = readEvalRun(runDir);

    expect(run.runDir).toBe(runDir);
    expect(run.tasksById["task-1"]).toMatchObject({
      taskId: "task-1",
      task: { task_id: "task-1", goal: "Return Paris", args: {} },
      recordPath: recordPath("task-1"),
      status: "ok",
    });
  });

  it("marks successful summary tasks with missing eval records as missing", () => {
    writeTask("missing-record", { task_id: "missing-record", goal: "Return Paris", args: {} });
    writeSummary([{ taskId: "missing-record", status: "success", evalRecordPath: recordPath("missing-record"), statelogPath: "", workdirPath: "" }]);

    expect(readEvalRun(runDir).tasksById["missing-record"]).toMatchObject({
      taskId: "missing-record",
      status: "missing",
      recordPath: recordPath("missing-record"),
    });
  });

  it("marks failed summary tasks as failed and reads error text", () => {
    writeTask("failed", { task_id: "failed", goal: "Return Paris", args: {} });
    writeError("failed", "boom");
    writeSummary([{ taskId: "failed", status: "error", evalRecordPath: recordPath("failed"), statelogPath: "", workdirPath: "", errorMessage: "summary boom" }]);

    expect(readEvalRun(runDir).tasksById.failed).toMatchObject({
      taskId: "failed",
      status: "failed",
      errorMessage: "boom",
    });
  });

  it("ignores task directories that are not present in summary.json", () => {
    writeTask("task-1", { task_id: "task-1", goal: "Return Paris", args: {} });
    writeRecord("task-1", { recordVersion: 2, evalOutputs: [{ value: "Paris", tMs: 1 }] });
    writeTask("extra", { task_id: "extra", goal: "Ignore me", args: {} });
    writeRecord("extra", { recordVersion: 2, evalOutputs: [{ value: "extra", tMs: 1 }] });
    writeSummary([{ taskId: "task-1", status: "success", evalRecordPath: recordPath("task-1"), statelogPath: "", workdirPath: "" }]);

    expect(Object.keys(readEvalRun(runDir).tasksById)).toEqual(["task-1"]);
  });

  function writeSummary(tasks: any[]): void {
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
      runId: "run-a",
      runDir,
      agent: "agent.agency:main",
      tasks,
      okCount: tasks.filter((task) => task.status === "success").length,
      errorCount: tasks.filter((task) => task.status === "error").length,
    }, null, 2));
  }

  function writeTask(taskId: string, task: unknown): void {
    fs.mkdirSync(path.join(runDir, "tasks", taskId), { recursive: true });
    fs.writeFileSync(path.join(runDir, "tasks", taskId, "task.json"), JSON.stringify(task, null, 2));
  }

  function writeRecord(taskId: string, record: unknown): void {
    fs.mkdirSync(path.join(runDir, "tasks", taskId), { recursive: true });
    fs.writeFileSync(recordPath(taskId), JSON.stringify(record, null, 2));
  }

  function writeError(taskId: string, message: string): void {
    fs.mkdirSync(path.join(runDir, "tasks", taskId), { recursive: true });
    fs.writeFileSync(path.join(runDir, "tasks", taskId, "error.txt"), message);
  }

  function recordPath(taskId: string): string {
    return path.join(runDir, "tasks", taskId, "eval-record.json");
  }
});
