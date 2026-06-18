import * as fs from "fs";
import * as path from "path";

import {
  prepareInput,
  recordInputPrepareFailure,
  recordInputRunFailure,
  recordInputSuccess,
  shouldExtractStatelog,
  type EvalRunState,
  type PreparedInput,
} from "./runArtifacts.js";
import type {
  EvalRunCompiledAgent,
  Input,
  EvalRunInputResult,
} from "./runTypes.js";

/**
 * How to actually invoke the compiled agent for an input. The CLI plugs in a
 * subprocess fork; alternative callers (tests, in-process variants) can
 * plug in their own runner. Must never throw — failures are returned as
 * `{ ok: false, errorMessage }`.
 *
 * On success the runner may report the path where it actually wrote the
 * statelog. When omitted, the framework uses the `statelogPath` it provided
 * to the runner.
 */
export type EvalInputRunner = (args: {
  compiled: EvalRunCompiledAgent;
  node: string;
  args: Record<string, any>;
  cwd: string;
  statelogPath: string;
}) => Promise<{ ok: true; statelogPath?: string } | { ok: false; errorMessage: string }>;

/**
 * How to turn a written statelog into an eval-record.json. Must never throw
 * — failures should be raised by the caller, not encoded as input errors,
 * because they indicate a bug in the extractor rather than an input failure.
 * Errors are still caught here so they get routed into the input result.
 */
export type EvalRecordExtractor = (args: {
  statelogPath: string;
  outPath: string;
  input: Input;
}) => Promise<void>;

/**
 * Single source of truth for "run one eval input end-to-end."
 *
 * Both the CLI (`agency eval run`) and the stdlib (`std::agency/eval.evalRun`)
 * route through this function so the prepare → invoke → extract → record
 * pipeline lives in exactly one place. Callers only supply the *how* of
 * invoking the agent; the *what* (artifact layout, error routing, summary
 * shape) is fixed here.
 *
 * Never throws — every failure path is reified as an `EvalRunInputResult`.
 */
export async function runEvalInput(args: {
  state: EvalRunState;
  input: Input;
  compiled: EvalRunCompiledAgent;
  defaultNode: string;
  runner: EvalInputRunner;
  extractor: EvalRecordExtractor;
}): Promise<EvalRunInputResult> {
  const inputId = args.input.id ?? "";
  let prepared: PreparedInput;
  try {
    prepared = prepareInput(args.state, args.input);
  } catch (err) {
    const message = errMessage(err);
    console.error(`[evalRun] prepare failed for input ${inputId}: ${message}`);
    return recordInputPrepareFailure(inputId, message);
  }

  const runResult = await args.runner({
    compiled: args.compiled,
    node: args.input.node ?? args.defaultNode,
    args: args.input.args,
    cwd: prepared.workdirPath,
    statelogPath: prepared.statelogPath,
  });
  if (!runResult.ok) {
    return recordInputRunFailure(prepared, runResult.errorMessage);
  }

  const statelogPath = runResult.statelogPath ?? prepared.statelogPath;
  ensureStatelogAtExpectedPath(prepared, statelogPath);
  if (shouldExtractStatelog(statelogPath)) {
    try {
      await args.extractor({
        statelogPath,
        outPath: prepared.evalRecordPath,
        input: args.input,
      });
    } catch (err) {
      const message = errMessage(err);
      console.error(`[evalRun] extract failed for input ${inputId}: ${message}`);
      return recordInputRunFailure(prepared, message);
    }
  }

  return recordInputSuccess(prepared);
}

function ensureStatelogAtExpectedPath(prepared: PreparedInput, statelogPath: string): void {
  if (statelogPath !== prepared.statelogPath || shouldExtractStatelog(statelogPath)) return;

  const fallbackPath = path.join(prepared.workdirPath, "statelog.log");
  if (shouldExtractStatelog(fallbackPath)) {
    fs.copyFileSync(fallbackPath, prepared.statelogPath);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
