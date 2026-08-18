import * as fs from "fs";
import * as path from "path";

import { agentRunPaths } from "./run/extract.js";
import type { EvalRunResult, EvalRunInputResult, Test } from "./runTypes.js";

export type ReadEvalRunInput = {
  inputId: string;
  input?: Test;
  recordPath?: string;
  status: "ok" | "missing" | "failed";
  errorMessage?: string;
};

export type ReadEvalRunResult = {
  runDir: string;
  inputsById: Record<string, ReadEvalRunInput>;
};

export function readEvalRun(
  runDir: string,
  onWarning: (message: string) => void = console.warn,
): ReadEvalRunResult {
  const resolvedRunDir = path.resolve(runDir);
  const summary = readJson<EvalRunResult>(path.join(resolvedRunDir, "summary.json"));
  const inputsById: Record<string, ReadEvalRunInput> = {};

  for (const result of summary.inputs) {
    const inputDir = path.join(resolvedRunDir, "inputs", result.inputId);
    const input = readOptionalJson<Test>(path.join(inputDir, "input.json"), onWarning);
    const recordPath = result.evalRecordPath || agentRunPaths(inputDir).evalRecordPath;
    const status = inputStatus(result, recordPath);
    const errorMessage =
      status === "failed"
        ? (readOptionalText(agentRunPaths(inputDir).errorPath) ?? result.errorMessage)
        : undefined;

    if (Object.hasOwn(inputsById, result.inputId)) {
      // The by-id map would silently swallow one of them, changing the mean's
      // denominator. Unreachable via the CLI (loadInputs rejects duplicate
      // ids), but programmatic callers skip that validation.
      onWarning(
        `readEvalRun: duplicate inputId "${result.inputId}" in ${resolvedRunDir} — keeping the last`,
      );
    }
    inputsById[result.inputId] = {
      inputId: result.inputId,
      ...(input ? { input } : {}),
      ...(recordPath ? { recordPath } : {}),
      status,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  warnIfLegacyLayout(resolvedRunDir, inputsById, onWarning);
  return { runDir: resolvedRunDir, inputsById };
}

/** The pre-#733 flat layout is no longer read. Without this, grading such a
 *  run prints objective 0.00 with every input "missing" — which reads like an
 *  agent that produced nothing, not like an old directory. Name what
 *  happened, once. */
function warnIfLegacyLayout(
  runDir: string,
  inputsById: Record<string, ReadEvalRunInput>,
  onWarning: (message: string) => void,
): void {
  const all = Object.values(inputsById);
  const allMissing = all.length > 0 && all.every((input) => input.status === "missing");
  if (!allMissing) return;
  const hasFlatRecord = all.some((input) =>
    fs.existsSync(path.join(runDir, "inputs", input.inputId, "eval-record.json")),
  );
  if (hasFlatRecord) {
    onWarning(
      `readEvalRun: ${runDir} uses the pre-#733 run layout and is no longer readable. ` +
        `Re-run the suite, or read this directory with a build from before PR #737.`,
    );
  }
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

function readOptionalJson<T>(
  filePath: string,
  onWarning: (message: string) => void,
): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    // Degrade, do not throw: grading runs after every agent has been paid for,
    // and one corrupt per-input file must not take the whole pass down.
    onWarning(`readEvalRun: could not parse ${filePath}: ${errText(error)}`);
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
