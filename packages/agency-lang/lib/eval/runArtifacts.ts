import * as fs from "fs";
import * as path from "path";

import { assertEvalRunId, assertEvalInputId } from "./ids.js";
import type {
  EvalRunResult,
  Input,
  EvalRunInputResult,
} from "./runTypes.js";

export type EvalRunState = {
  runId: string;
  runDir: string;
  inputsDir: string;
  agent: string;
  inputsSource: string;
  continueOnError: boolean;
};

export type PreparedInput = {
  input: Input;
  inputDir: string;
  inputJsonPath: string;
  statelogPath: string;
  evalRecordPath: string;
  workdirPath: string;
  errorPath: string;
};

export function initializeEvalRun(args: {
  runId: string;
  runsDir: string;
  agent: string;
  inputsSource: string;
  inputs: Input[];
  continueOnError: boolean;
  startedAt: Date;
}): EvalRunState {
  assertEvalRunId(args.runId);

  const runDir = path.resolve(args.runsDir, args.runId);
  const inputsDir = path.join(runDir, "tasks");
  if (fs.existsSync(runDir)) {
    throw new Error(
      `Run directory already exists: ${runDir}.
Choose a different --run-id or delete the existing directory.`,
    );
  }
  fs.mkdirSync(inputsDir, { recursive: true });

  writeJson(path.join(runDir, "config.json"), {
    runId: args.runId,
    agent: args.agent,
    tasksSource: args.inputsSource,
    tasks: args.inputs,
    continueOnError: args.continueOnError,
    startedAt: args.startedAt.toISOString(),
  });

  return {
    runId: args.runId,
    runDir,
    inputsDir,
    agent: args.agent,
    inputsSource: args.inputsSource,
    continueOnError: args.continueOnError,
  };
}

export function prepareInput(
  state: EvalRunState,
  input: Input,
): PreparedInput {
  const id = input.id ?? "";
  assertEvalInputId(id);

  const inputDir = path.join(state.inputsDir, id);
  const workdirPath = path.join(inputDir, "workdir");
  fs.mkdirSync(inputDir, { recursive: true });

  if (input.working_dir) {
    const workingDirStat = fs.statSync(input.working_dir);
    if (!workingDirStat.isDirectory()) {
      throw new Error("Eval task working_dir must be a directory");
    }
    fs.cpSync(input.working_dir, workdirPath, { recursive: true });
  } else {
    fs.mkdirSync(workdirPath, { recursive: true });
  }

  const prepared: PreparedInput = {
    input,
    inputDir,
    inputJsonPath: path.join(inputDir, "task.json"),
    statelogPath: path.join(inputDir, "statelog.jsonl"),
    evalRecordPath: path.join(inputDir, "eval-record.json"),
    workdirPath,
    errorPath: path.join(inputDir, "error.txt"),
  };

  // Defensive cleanup so re-runs of the same input id don't see stale
  // artifacts. We use raw rmSync (not utils.safeDeleteFile) because the
  // user can point runsDir at any path — including /tmp — and
  // safeDeleteFile refuses anything outside a project root. The targets
  // here are paths *we* just constructed under the validated inputDir, so
  // the project-root containment check is the wrong safeguard.
  for (const filePath of [prepared.statelogPath, prepared.evalRecordPath, prepared.errorPath]) {
    fs.rmSync(filePath, { force: true });
  }

  writeJson(prepared.inputJsonPath, input);
  return prepared;
}

/**
 * Build an EvalRunInputResult for an input that failed before any artifacts
 * were prepared (e.g. invalid id, working_dir validation). The result
 * carries no on-disk paths because none were allocated.
 */
export function recordInputPrepareFailure(
  inputId: string,
  errorMessage: string,
): EvalRunInputResult {
  return {
    inputId,
    status: "error",
    evalRecordPath: "",
    statelogPath: "",
    workdirPath: "",
    errorMessage,
  };
}

/**
 * Build an EvalRunInputResult for a prepared input that failed during run or
 * extract. Writes the error message to the input's error.txt for offline
 * inspection.
 */
export function recordInputRunFailure(
  prepared: PreparedInput,
  errorMessage: string,
): EvalRunInputResult {
  fs.writeFileSync(prepared.errorPath, errorMessage);
  return {
    inputId: prepared.input.id ?? "",
    status: "error",
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
    errorMessage,
  };
}

export function recordInputSuccess(
  prepared: PreparedInput,
): EvalRunInputResult {
  return {
    inputId: prepared.input.id ?? "",
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
  inputs: EvalRunInputResult[],
): EvalRunResult {
  const summary: EvalRunResult = {
    runId: state.runId,
    runDir: state.runDir,
    agent: state.agent,
    inputs,
    okCount: inputs.filter((input) => input.status === "success").length,
    errorCount: inputs.filter((input) => input.status === "error").length,
  };
  writeJson(path.join(state.runDir, "summary.json"), summary);
  return summary;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
