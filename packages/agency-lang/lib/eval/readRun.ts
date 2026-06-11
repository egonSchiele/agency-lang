import * as fs from "fs";
import * as path from "path";

import type { EvalRunResult, EvalRunTaskResult, EvalTask } from "./runTypes.js";

export type ReadEvalRunTask = {
  taskId: string;
  task?: EvalTask;
  recordPath?: string;
  status: "ok" | "missing" | "failed";
  errorMessage?: string;
};

export type ReadEvalRunResult = {
  runDir: string;
  tasksById: Record<string, ReadEvalRunTask>;
};

export function readEvalRun(runDir: string): ReadEvalRunResult {
  const resolvedRunDir = path.resolve(runDir);
  const summary = readJson<EvalRunResult>(path.join(resolvedRunDir, "summary.json"));
  const tasksById: Record<string, ReadEvalRunTask> = {};

  for (const result of summary.tasks) {
    const taskDir = path.join(resolvedRunDir, "tasks", result.taskId);
    const task = readOptionalJson<EvalTask>(path.join(taskDir, "task.json"));
    const recordPath = result.evalRecordPath || path.join(taskDir, "eval-record.json");
    const status = taskStatus(result, recordPath);
    const errorMessage = status === "failed"
      ? readOptionalText(path.join(taskDir, "error.txt")) ?? result.errorMessage
      : undefined;

    tasksById[result.taskId] = {
      taskId: result.taskId,
      ...(task ? { task } : {}),
      ...(recordPath ? { recordPath } : {}),
      status,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  return { runDir: resolvedRunDir, tasksById };
}

function taskStatus(result: EvalRunTaskResult, recordPath: string): ReadEvalRunTask["status"] {
  if (result.status === "error") return "failed";
  return fs.existsSync(recordPath) ? "ok" : "missing";
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readOptionalJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return readJson<T>(filePath);
}

function readOptionalText(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, "utf-8");
}
