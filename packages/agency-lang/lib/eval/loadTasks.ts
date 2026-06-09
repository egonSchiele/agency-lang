import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { assertEvalTaskId } from "./ids.js";
import type { EvalRunTask } from "./runTypes.js";

type MakeId = () => string;

export function taskFromGoal(goal: string, makeId: MakeId = nanoid): EvalRunTask {
  if (typeof goal !== "string" || goal.length === 0) {
    throw new Error("--goal must be a non-empty string");
  }
  return { task_id: makeId(), rubric: goal, args: {} };
}

export function loadTasks(sourcePath: string, makeId: MakeId = nanoid): EvalRunTask[] {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return loadTasksFromDirectory(sourcePath, makeId);
  }
  return loadTasksFromFile(sourcePath, makeId);
}

export function loadTasksFromFile(filePath: string, makeId: MakeId = nanoid): EvalRunTask[] {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).tasks)) {
    throw new Error(`Task suite ${filePath} must contain a top-level tasks array`);
  }
  return validateTasks(
    (parsed as any).tasks.map((raw: unknown) => normalizeTask(raw, path.dirname(filePath), makeId)),
  );
}

function loadTasksFromDirectory(directoryPath: string, makeId: MakeId): EvalRunTask[] {
  const files = fs
    .readdirSync(directoryPath)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return validateTasks(
    files.map((file) => normalizeTask(readJson(path.join(directoryPath, file)), directoryPath, makeId)),
  );
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read task JSON ${filePath}: ${(err as Error).message}`);
  }
}

function normalizeTask(raw: unknown, baseDir: string, makeId: MakeId): EvalRunTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Eval task must be a JSON object");
  }
  const task = raw as Record<string, unknown>;
  if (typeof task.rubric !== "string" || task.rubric.length === 0) {
    throw new Error("Eval task rubric must be a non-empty string");
  }
  if (task.args !== undefined && (!task.args || typeof task.args !== "object" || Array.isArray(task.args))) {
    throw new Error("Eval task args must be an object when provided");
  }
  if (task.node !== undefined && typeof task.node !== "string") {
    throw new Error("Eval task node must be a string when provided");
  }
  if (task.working_dir !== undefined && typeof task.working_dir !== "string") {
    throw new Error("Eval task working_dir must be a string when provided");
  }
  const out: EvalRunTask = {
    task_id: typeof task.task_id === "string" ? task.task_id : makeId(),
    rubric: task.rubric,
    args: (task.args ?? {}) as Record<string, any>,
  };
  if (typeof task.node === "string") out.node = task.node;
  if (typeof task.working_dir === "string") out.working_dir = path.resolve(baseDir, task.working_dir);
  return out;
}

function validateTasks(tasks: EvalRunTask[]): EvalRunTask[] {
  const seen: Record<string, true> = {};
  for (const task of tasks) {
    assertEvalTaskId(task.task_id);
    if (seen[task.task_id]) {
      throw new Error(`Duplicate task_id "${task.task_id}"`);
    }
    seen[task.task_id] = true;
  }
  return tasks;
}
