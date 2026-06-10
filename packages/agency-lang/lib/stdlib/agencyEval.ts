import * as fs from "fs";

import { nanoid } from "nanoid";

import { extractEvalRecord } from "../eval/extract.js";
import { readAllEvents } from "../eval/parseJsonl.js";
import {
  initializeEvalRun,
  prepareEvalRunTask,
  recordEvalRunTaskPrepareFailure,
  recordEvalRunTaskRunFailure,
  recordEvalRunTaskSuccess,
  shouldExtractStatelog,
  writeEvalRunSummary,
  type EvalRunState,
  type PreparedEvalRunTask,
} from "../eval/runArtifacts.js";
import type {
  EvalRunResult,
  EvalRunTask,
  EvalRunTaskResult,
} from "../eval/runTypes.js";

/**
 * State carried by the Agency-side `evalRun` loop. Note: this is just the
 * underlying `EvalRunState` plus the parsed task list — we deliberately do
 * not stash a mutable `results: EvalRunTaskResult[]` here. The Agency loop
 * accumulates results in its own local array so the data flow is visible
 * at the call site instead of hidden as a side effect.
 */
export type AgencyEvalRunState = EvalRunState & {
  tasks: EvalRunTask[];
};

/**
 * Result of the "prepare" step exposed to Agency. Discriminated so the
 * Agency loop can branch on `.ok` instead of relying on `try` to catch
 * thrown errors from the TS helper.
 */
export type AgencyPrepareResult =
  | { ok: true; prepared: PreparedEvalRunTask }
  | { ok: false; result: EvalRunTaskResult };

export function _initEvalRun(
  compiled: { moduleId: string },
  tasks: EvalRunTask[],
  node: string,
  runsDir: string,
  runId: string,
  continueOnError: boolean,
): AgencyEvalRunState {
  const state = initializeEvalRun({
    runId: runId || nanoid(),
    runsDir,
    agent: `${compiled.moduleId}:${node}`,
    tasksSource: "stdlib:evalRun",
    tasks,
    continueOnError,
    startedAt: new Date(),
  });
  return { ...state, tasks };
}

/**
 * Prepare a task's artifacts. Never throws — validation errors are returned
 * as a `{ ok: false, result }` so the Agency loop has a single branching
 * pattern (`if (prep.ok)`) instead of an extra `try` per iteration.
 */
export function _prepareEvalRunTask(
  state: AgencyEvalRunState,
  task: EvalRunTask,
): AgencyPrepareResult {
  try {
    return { ok: true, prepared: prepareEvalRunTask(state, task) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[evalRun] prepare failed for task ${task.task_id}: ${message}`);
    return {
      ok: false,
      result: recordEvalRunTaskPrepareFailure(task.task_id, message),
    };
  }
}

/**
 * Finalize a prepared task after `std::agency.run` returned. `runError` is
 * empty on success, otherwise a flattened error message from the Agency
 * `try`/`isFailure` branch. Extracts the eval record when a statelog was
 * written. Never throws — any extract failure is turned into an error
 * result so the Agency loop never has to wrap this call in `try`.
 */
export async function _finalizeEvalRunTask(
  prepared: PreparedEvalRunTask,
  runError: string,
): Promise<EvalRunTaskResult> {
  if (runError) {
    return recordEvalRunTaskRunFailure(prepared, runError);
  }
  if (shouldExtractStatelog(prepared.statelogPath)) {
    try {
      const events = await readAllEvents(prepared.statelogPath);
      const record = extractEvalRecord(events, prepared.statelogPath);
      fs.writeFileSync(prepared.evalRecordPath, JSON.stringify(record, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[evalRun] extract failed for task ${prepared.task.task_id}: ${message}`);
      return recordEvalRunTaskRunFailure(prepared, message);
    }
  }
  return recordEvalRunTaskSuccess(prepared);
}

export function _finishEvalRun(
  state: AgencyEvalRunState,
  results: EvalRunTaskResult[],
): EvalRunResult {
  return writeEvalRunSummary(state, results);
}

/**
 * Flatten an Agency `try` failure value into a single string message. The
 * shape can vary because failures come from a mix of structured limit
 * payloads, JS Error wrappers, and plain strings.
 */
export function _formatEvalRunFailure(value: any): string {
  const candidate =
    value?.error?.message ??
    value?.value?.message ??
    value?.message ??
    value?.value ??
    value;
  return typeof candidate === "string" ? candidate : JSON.stringify(candidate);
}
