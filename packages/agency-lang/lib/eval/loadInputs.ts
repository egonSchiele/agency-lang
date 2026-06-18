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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).inputs)) {
    throw new Error(`Input suite ${filePath} must contain a top-level inputs array`);
  }
  return validateInputs(
    (parsed as any).inputs.map((raw: unknown) => normalizeInput(raw, path.dirname(filePath), makeId)),
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
    throw new Error(`Failed to read input JSON ${filePath}: ${(err as Error).message}`);
  }
}

function normalizeInput(raw: unknown, baseDir: string, makeId: MakeId): Input {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Eval input must be a JSON object");
  }
  const spec = raw as Record<string, unknown>;
  if (spec.goal !== undefined && spec.rubric !== undefined) {
    throw new Error("Eval input cannot specify both goal and rubric");
  }
  if (typeof spec.goal !== "string" || spec.goal.length === 0) {
    throw new Error("Eval input goal must be a non-empty string");
  }
  if (spec.args !== undefined && (!spec.args || typeof spec.args !== "object" || Array.isArray(spec.args))) {
    throw new Error("Eval input args must be an object when provided");
  }
  if (spec.node !== undefined && typeof spec.node !== "string") {
    throw new Error("Eval input node must be a string when provided");
  }
  if (spec.working_dir !== undefined && typeof spec.working_dir !== "string") {
    throw new Error("Eval input working_dir must be a string when provided");
  }
  const out: Input = {
    id: typeof spec.id === "string" ? spec.id : makeId(),
    goal: spec.goal,
    args: (spec.args ?? {}) as Record<string, any>,
  };
  if (typeof spec.node === "string") out.node = spec.node;
  if (typeof spec.working_dir === "string") out.working_dir = path.resolve(baseDir, spec.working_dir);
  return out;
}

function validateInputs(inputs: Input[]): Input[] {
  const seen: Record<string, true> = {};
  for (const input of inputs) {
    const id = input.id ?? "";
    assertEvalInputId(id);
    if (seen[id]) {
      throw new Error(`Duplicate id "${id}"`);
    }
    seen[id] = true;
  }
  return inputs;
}
