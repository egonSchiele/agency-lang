import * as fs from "fs";
import * as path from "path";

import { agentRunPaths } from "./run/extract.js";
import type { EvalRunResult, EvalRunInputResult, Input } from "./runTypes.js";

export type ReadEvalRunInput = {
  inputId: string;
  input?: Input;
  recordPath?: string;
  status: "ok" | "missing" | "failed";
  errorMessage?: string;
};

export type ReadEvalRunResult = {
  runDir: string;
  inputsById: Record<string, ReadEvalRunInput>;
};

export function readEvalRun(runDir: string): ReadEvalRunResult {
  const resolvedRunDir = path.resolve(runDir);
  const summary = readJson<EvalRunResult>(path.join(resolvedRunDir, "summary.json"));
  const inputsById: Record<string, ReadEvalRunInput> = {};

  for (const result of summary.inputs) {
    const inputDir = path.join(resolvedRunDir, "inputs", result.inputId);
    const input = readOptionalJson<Input>(path.join(inputDir, "input.json"));
    const recordPath = result.evalRecordPath || agentRunPaths(inputDir).evalRecordPath;
    const status = inputStatus(result, recordPath);
    const errorMessage = status === "failed"
      ? readOptionalText(agentRunPaths(inputDir).errorPath) ?? result.errorMessage
      : undefined;

    if (Object.hasOwn(inputsById, result.inputId)) {
      // The by-id map would silently swallow one of them, changing the mean's
      // denominator. Unreachable via the CLI (loadInputs rejects duplicate
      // ids), but programmatic callers skip that validation.
      console.warn(`readEvalRun: duplicate inputId "${result.inputId}" in ${resolvedRunDir} — keeping the last`);
    }
    inputsById[result.inputId] = {
      inputId: result.inputId,
      ...(input ? { input } : {}),
      ...(recordPath ? { recordPath } : {}),
      status,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  return { runDir: resolvedRunDir, inputsById };
}

function inputStatus(result: EvalRunInputResult, recordPath: string): ReadEvalRunInput["status"] {
  if (result.status === "error") return "failed";
  return fs.existsSync(recordPath) ? "ok" : "missing";
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    throw new Error(`could not read ${filePath}: ${errText(error)}`);
  }
}

function readOptionalJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    // Degrade, do not throw: grading runs after every agent has been paid for,
    // and one corrupt per-input file must not take the whole pass down.
    console.warn(`readEvalRun: could not parse ${filePath}: ${errText(error)}`);
    return undefined;
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOptionalText(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, "utf-8");
}
