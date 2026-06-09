import * as fs from "fs";
import * as path from "path";

import type { EvalRunTask, EvalRunTaskResult, EvalRunResult } from "./runTypes.js";

export type EvalRunState = {
  runId: string;
  runDir: string;
  tasksDir: string;
  agent: string;
  tasksSource: string;
  continueOnError: boolean;
};

export type PreparedEvalRunTask = {
  task: EvalRunTask;
  taskDir: string;
  taskJsonPath: string;
  statelogPath: string;
  evalRecordPath: string;
  workdirPath: string;
  errorPath: string;
};

export function initializeEvalRun(args: {
  runId: string;
  runsDir: string;
  agent: string;
  tasksSource: string;
  tasks: EvalRunTask[];
  continueOnError: boolean;
  startedAt: Date;
}): EvalRunState {
  const runDir = path.resolve(args.runsDir, args.runId);
  const tasksDir = path.join(runDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  writeJson(path.join(runDir, "config.json"), {
    runId: args.runId,
    agent: args.agent,
    tasksSource: args.tasksSource,
    tasks: args.tasks,
    continueOnError: args.continueOnError,
    startedAt: args.startedAt.toISOString(),
  });
  return {
    runId: args.runId,
    runDir,
    tasksDir,
    agent: args.agent,
    tasksSource: args.tasksSource,
    continueOnError: args.continueOnError,
  };
}

export function prepareEvalRunTask(state: EvalRunState, task: EvalRunTask): PreparedEvalRunTask {
  const taskDir = path.join(state.tasksDir, task.task_id);
  const workdirPath = path.join(taskDir, "workdir");
  fs.mkdirSync(taskDir, { recursive: true });
  if (task.working_dir) {
    fs.cpSync(task.working_dir, workdirPath, { recursive: true });
  } else {
    fs.mkdirSync(workdirPath, { recursive: true });
  }
  const prepared = {
    task,
    taskDir,
    taskJsonPath: path.join(taskDir, "task.json"),
    statelogPath: path.join(taskDir, "statelog.jsonl"),
    evalRecordPath: path.join(taskDir, "eval-record.json"),
    workdirPath,
    errorPath: path.join(taskDir, "error.txt"),
  };
  fs.rmSync(prepared.statelogPath, { force: true });
  fs.rmSync(prepared.evalRecordPath, { force: true });
  fs.rmSync(prepared.errorPath, { force: true });
  writeJson(prepared.taskJsonPath, task);
  return prepared;
}

export function recordEvalRunTaskError(prepared: PreparedEvalRunTask | EvalRunTask, errorMessage: string): EvalRunTaskResult {
  if ("taskDir" in prepared) {
    fs.writeFileSync(prepared.errorPath, errorMessage);
    return {
      taskId: prepared.task.task_id,
      status: "error",
      evalRecordPath: prepared.evalRecordPath,
      statelogPath: prepared.statelogPath,
      workdirPath: prepared.workdirPath,
      errorMessage,
    };
  }
  return {
    taskId: prepared.task_id,
    status: "error",
    evalRecordPath: "",
    statelogPath: "",
    workdirPath: "",
    errorMessage,
  };
}

export function recordEvalRunTaskSuccess(prepared: PreparedEvalRunTask): EvalRunTaskResult {
  return {
    taskId: prepared.task.task_id,
    status: "success",
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
  };
}

export function shouldExtractStatelog(statelogPath: string): boolean {
  try {
    return fs.statSync(statelogPath).size > 0;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export function writeEvalRunSummary(state: EvalRunState, tasks: EvalRunTaskResult[]): EvalRunResult {
  const summary = {
    runId: state.runId,
    runDir: state.runDir,
    agent: state.agent,
    tasks,
    okCount: tasks.filter((task) => task.status === "success").length,
    errorCount: tasks.filter((task) => task.status === "error").length,
  } satisfies EvalRunResult;
  writeJson(path.join(state.runDir, "summary.json"), summary);
  return summary;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
