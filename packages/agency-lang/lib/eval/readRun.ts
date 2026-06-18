import * as fs from "fs";
import * as path from "path";

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
    const recordPath = result.evalRecordPath || path.join(inputDir, "eval-record.json");
    const status = inputStatus(result, recordPath);
    const errorMessage = status === "failed"
      ? readOptionalText(path.join(inputDir, "error.txt")) ?? result.errorMessage
      : undefined;

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
