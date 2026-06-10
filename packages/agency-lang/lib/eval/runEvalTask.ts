import {
  prepareEvalRunTask,
  recordEvalRunTaskPrepareFailure,
  recordEvalRunTaskRunFailure,
  recordEvalRunTaskSuccess,
  shouldExtractStatelog,
  type EvalRunState,
  type PreparedEvalRunTask,
} from "./runArtifacts.js";
import type {
  EvalRunCompiledAgent,
  EvalRunTask,
  EvalRunTaskResult,
} from "./runTypes.js";

/**
 * How to actually invoke the compiled agent for a task. The CLI plugs in a
 * subprocess fork; alternative callers (tests, in-process variants) can
 * plug in their own runner. Must never throw — failures are returned as
 * `{ ok: false, errorMessage }`.
 *
 * On success the runner may report the path where it actually wrote the
 * statelog. When omitted, the framework uses the `statelogPath` it provided
 * to the runner.
 */
export type EvalTaskRunner = (args: {
  compiled: EvalRunCompiledAgent;
  node: string;
  args: Record<string, any>;
  cwd: string;
  statelogPath: string;
}) => Promise<{ ok: true; statelogPath?: string } | { ok: false; errorMessage: string }>;

/**
 * How to turn a written statelog into an eval-record.json. Must never throw
 * — failures should be raised by the caller, not encoded as task errors,
 * because they indicate a bug in the extractor rather than a task failure.
 * Errors are still caught here so they get routed into the task result.
 */
export type EvalRecordExtractor = (args: {
  statelogPath: string;
  outPath: string;
  task: EvalRunTask;
}) => Promise<void>;

/**
 * Single source of truth for "run one eval task end-to-end."
 *
 * Both the CLI (`agency eval run`) and the stdlib (`std::agency/eval.evalRun`)
 * route through this function so the prepare → invoke → extract → record
 * pipeline lives in exactly one place. Callers only supply the *how* of
 * invoking the agent; the *what* (artifact layout, error routing, summary
 * shape) is fixed here.
 *
 * Never throws — every failure path is reified as an `EvalRunTaskResult`.
 */
export async function runEvalTask(args: {
  state: EvalRunState;
  task: EvalRunTask;
  compiled: EvalRunCompiledAgent;
  defaultNode: string;
  runner: EvalTaskRunner;
  extractor: EvalRecordExtractor;
}): Promise<EvalRunTaskResult> {
  let prepared: PreparedEvalRunTask;
  try {
    prepared = prepareEvalRunTask(args.state, args.task);
  } catch (err) {
    const message = errMessage(err);
    console.error(`[evalRun] prepare failed for task ${args.task.task_id}: ${message}`);
    return recordEvalRunTaskPrepareFailure(args.task.task_id, message);
  }

  const runResult = await args.runner({
    compiled: args.compiled,
    node: args.task.node ?? args.defaultNode,
    args: args.task.args,
    cwd: prepared.workdirPath,
    statelogPath: prepared.statelogPath,
  });
  if (!runResult.ok) {
    return recordEvalRunTaskRunFailure(prepared, runResult.errorMessage);
  }

  const statelogPath = runResult.statelogPath ?? prepared.statelogPath;
  if (shouldExtractStatelog(statelogPath)) {
    try {
      await args.extractor({
        statelogPath,
        outPath: prepared.evalRecordPath,
        task: args.task,
      });
    } catch (err) {
      const message = errMessage(err);
      console.error(`[evalRun] extract failed for task ${args.task.task_id}: ${message}`);
      return recordEvalRunTaskRunFailure(prepared, message);
    }
  }

  return recordEvalRunTaskSuccess(prepared);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
