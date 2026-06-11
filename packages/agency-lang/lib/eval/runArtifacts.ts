import * as fs from "fs";
import * as path from "path";

import { assertEvalRunId, assertEvalTaskId } from "./ids.js";
import type {
  EvalRunResult,
  EvalRunTask,
  EvalRunTaskResult,
} from "./runTypes.js";

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
  assertEvalRunId(args.runId);

  const runDir = path.resolve(args.runsDir, args.runId);
  const tasksDir = path.join(runDir, "tasks");
  if (fs.existsSync(runDir)) {
    throw new Error(
      `Run directory already exists: ${runDir}.
Choose a different --run-id or delete the existing directory.`,
    );
  }
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

export function prepareEvalRunTask(
  state: EvalRunState,
  task: EvalRunTask,
): PreparedEvalRunTask {
  assertEvalTaskId(task.task_id);

  const taskDir = path.join(state.tasksDir, task.task_id);
  const workdirPath = path.join(taskDir, "workdir");
  fs.mkdirSync(taskDir, { recursive: true });

  if (task.working_dir) {
    const workingDirStat = fs.statSync(task.working_dir);
    if (!workingDirStat.isDirectory()) {
      throw new Error("Eval task working_dir must be a directory");
    }
    fs.cpSync(task.working_dir, workdirPath, { recursive: true });
  } else {
    fs.mkdirSync(workdirPath, { recursive: true });
  }

  const prepared: PreparedEvalRunTask = {
    task,
    taskDir,
    taskJsonPath: path.join(taskDir, "task.json"),
    statelogPath: path.join(taskDir, "statelog.jsonl"),
    evalRecordPath: path.join(taskDir, "eval-record.json"),
    workdirPath,
    errorPath: path.join(taskDir, "error.txt"),
  };

  // Defensive cleanup so re-runs of the same task_id don't see stale
  // artifacts. We use raw rmSync (not utils.safeDeleteFile) because the
  // user can point runsDir at any path — including /tmp — and
  // safeDeleteFile refuses anything outside a project root. The targets
  // here are paths *we* just constructed under the validated taskDir, so
  // the project-root containment check is the wrong safeguard.
  for (const filePath of [prepared.statelogPath, prepared.evalRecordPath, prepared.errorPath]) {
    fs.rmSync(filePath, { force: true });
  }

  writeJson(prepared.taskJsonPath, task);
  return prepared;
}

/**
 * Build an EvalRunTaskResult for a task that failed before any artifacts
 * were prepared (e.g. invalid task_id, working_dir validation). The result
 * carries no on-disk paths because none were allocated.
 */
export function recordEvalRunTaskPrepareFailure(
  taskId: string,
  errorMessage: string,
): EvalRunTaskResult {
  return {
    taskId,
    status: "error",
    evalRecordPath: "",
    statelogPath: "",
    workdirPath: "",
    errorMessage,
  };
}

/**
 * Build an EvalRunTaskResult for a prepared task that failed during run or
 * extract. Writes the error message to the task's error.txt for offline
 * inspection.
 */
export function recordEvalRunTaskRunFailure(
  prepared: PreparedEvalRunTask,
  errorMessage: string,
): EvalRunTaskResult {
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

export function recordEvalRunTaskSuccess(
  prepared: PreparedEvalRunTask,
): EvalRunTaskResult {
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

export function writeEvalRunSummary(
  state: EvalRunState,
  tasks: EvalRunTaskResult[],
): EvalRunResult {
  const summary: EvalRunResult = {
    runId: state.runId,
    runDir: state.runDir,
    agent: state.agent,
    tasks,
    okCount: tasks.filter((task) => task.status === "success").length,
    errorCount: tasks.filter((task) => task.status === "error").length,
  };
  writeJson(path.join(state.runDir, "summary.json"), summary);
  return summary;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
