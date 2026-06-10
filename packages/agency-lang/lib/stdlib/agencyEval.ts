import * as fs from "fs";

import { nanoid } from "nanoid";

import { extractEvalRecord } from "../eval/extract.js";
import { judgePairwise } from "../eval/judge/pairwise.js";
import type { PairwiseVerdict } from "../eval/judge/types.js";
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
import type { EvalRecord } from "../eval/types.js";
import { optimizeLoop } from "../optimize/loop.js";
import type { OptimizeLoopConfig, OptimizeResult } from "../optimize/types.js";

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

/**
 * Stdlib binding for `eval extract`. Reads a JSONL statelog at
 * `statelogPath` and returns the structured EvalRecord that
 * `agency eval extract` would write. Composes the existing extractor
 * pipeline; no separate logic here.
 */
export async function _evalExtract(statelogPath: string): Promise<EvalRecord> {
  const events = await readAllEvents(statelogPath);
  return extractEvalRecord(events, statelogPath);
}

/**
 * Stdlib binding for `eval judge`. Pairwise-judges two eval records against
 * a rubric and returns the structured PairwiseVerdict. Delegates to the
 * existing `judgePairwise` so CLI and stdlib paths share judge behavior
 * (including the subprocess judge invocation through `runAgencyJudge`).
 */
export async function _evalJudge(
  rubric: string,
  recordPathA: string,
  recordPathB: string,
): Promise<PairwiseVerdict> {
  return judgePairwise(rubric, recordPathA, recordPathB);
}

/**
 * Stdlib binding for `agency.eval.optimize`. This deliberately does not
 * install any approval handler; callers decide which handlers are in scope.
 */
export async function _optimize(
  config: AgencyConfigLike,
  agentSource: string,
  node: string,
  tasks: EvalRunTask[],
  goal: string,
  iterations: number,
  judgeSamples: number,
  acceptThreshold: number,
  runsDir: string,
  runId: string,
  agentFilename: string,
  workingDir: string,
  mutatorModel?: string,
  loop: (config: OptimizeLoopConfig) => Promise<OptimizeResult> = optimizeLoop,
): Promise<OptimizeResult> {
  return loop({
    config,
    agentSource,
    node,
    tasks,
    goal,
    iterations,
    judgeSamples,
    acceptThreshold,
    runsDir,
    runId: runId || nanoid(),
    agentFilename,
    workingDir,
    mutatorModel,
  });
}

type AgencyConfigLike = OptimizeLoopConfig["config"];
