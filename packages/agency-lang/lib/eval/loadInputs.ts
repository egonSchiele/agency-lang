import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { assertEvalInputId } from "./ids.js";
import type { Input } from "./runTypes.js";

type MakeId = () => string;

export function inputFromGoal(goal: string): Input {
  if (typeof goal !== "string" || goal.length === 0) {
    throw new Error("--goal must be a non-empty string");
  }
  return { id: "input-1", goal, args: {} };
}

export function loadInputs(sourcePath: string, makeId: MakeId = nanoid): Input[] {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return loadInputsFromDirectory(sourcePath, makeId);
  }
  return loadInputsFromFile(sourcePath, makeId);
}

export function loadInputsFromFile(filePath: string, makeId: MakeId = nanoid): Input[] {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).tasks)) {
    throw new Error(`Task suite ${filePath} must contain a top-level tasks array`);
  }
  return validateInputs(
    (parsed as any).tasks.map((raw: unknown) => normalizeInput(raw, path.dirname(filePath), makeId)),
  );
}

function loadInputsFromDirectory(directoryPath: string, makeId: MakeId): Input[] {
  const files = fs
    .readdirSync(directoryPath)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return validateInputs(
    files.map((file) => normalizeInput(readJson(path.join(directoryPath, file)), directoryPath, makeId)),
  );
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read task JSON ${filePath}: ${(err as Error).message}`);
  }
}

function normalizeInput(raw: unknown, baseDir: string, makeId: MakeId): Input {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Eval task must be a JSON object");
  }
  const task = raw as Record<string, unknown>;
  if (task.goal !== undefined && task.rubric !== undefined) {
    throw new Error("Eval task cannot specify both goal and rubric");
  }
  if (typeof task.goal !== "string" || task.goal.length === 0) {
    throw new Error("Eval task goal must be a non-empty string");
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
  const out: Input = {
    id: typeof task.task_id === "string" ? task.task_id : makeId(),
    goal: task.goal,
    args: (task.args ?? {}) as Record<string, any>,
  };
  if (typeof task.node === "string") out.node = task.node;
  if (typeof task.working_dir === "string") out.working_dir = path.resolve(baseDir, task.working_dir);
  return out;
}

function validateInputs(inputs: Input[]): Input[] {
  const seen: Record<string, true> = {};
  for (const input of inputs) {
    const id = input.id ?? "";
    assertEvalInputId(id);
    if (seen[id]) {
      throw new Error(`Duplicate task_id "${id}"`);
    }
    seen[id] = true;
  }
  return inputs;
}
