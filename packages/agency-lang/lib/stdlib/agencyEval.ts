import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { judgePairwise } from "../eval/judge/pairwise.js";
import { judgeSuite, type JudgeSuiteArgs } from "../eval/judge/suite.js";
import type { PairwiseVerdict, SuiteVerdict } from "../eval/judge/types.js";
import { taskFromGoal } from "../eval/loadTasks.js";
import { StatelogParser } from "../eval/statelogParser.js";
import { createOptimizeReporter, type OptimizeVerbosity } from "../optimize/reporter.js";
import { discoverOptimizeTargets } from "../optimize/targets.js";
import {
  initializeEvalRun,
  prepareEvalTask,
  recordEvalTaskPrepareFailure,
  recordEvalTaskRunFailure,
  recordEvalTaskSuccess,
  shouldExtractStatelog,
  writeEvalRunSummary,
  type EvalRunState,
  type PreparedEvalTask,
} from "../eval/runArtifacts.js";
import type {
  EvalRunResult,
  EvalTask,
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
  tasks: EvalTask[];
};

/**
 * Result of the "prepare" step exposed to Agency. Discriminated so the
 * Agency loop can branch on `.ok` instead of relying on `try` to catch
 * thrown errors from the TS helper.
 */
export type AgencyPrepareResult =
  | { ok: true; prepared: PreparedEvalTask }
  | { ok: false; result: EvalRunTaskResult };

export function _initEvalRun(
  compiled: { moduleId: string },
  tasks: EvalTask[],
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
export function _prepareEvalTask(
  state: AgencyEvalRunState,
  task: EvalTask,
): AgencyPrepareResult {
  try {
    return { ok: true, prepared: prepareEvalTask(state, task) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[evalRun] prepare failed for task ${task.task_id}: ${message}`);
    return {
      ok: false,
      result: recordEvalTaskPrepareFailure(task.task_id, message),
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
export async function _finalizeEvalTask(
  prepared: PreparedEvalTask,
  runError: string,
): Promise<EvalRunTaskResult> {
  if (runError) {
    return recordEvalTaskRunFailure(prepared, runError);
  }
  if (shouldExtractStatelog(prepared.statelogPath)) {
    try {
      const record = new StatelogParser(prepared.statelogPath).evalRecord();
      fs.writeFileSync(prepared.evalRecordPath, JSON.stringify(record, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[evalRun] extract failed for task ${prepared.task.task_id}: ${message}`);
      return recordEvalTaskRunFailure(prepared, message);
    }
  }
  return recordEvalTaskSuccess(prepared);
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
  return new StatelogParser(statelogPath).evalRecord();
}

/**
 * Stdlib binding for `eval judge`. Pairwise-judges two eval records against
 * a goal and returns the structured PairwiseVerdict. Delegates to the
 * existing `judgePairwise` so CLI and stdlib paths share judge behavior
 * (including the subprocess judge invocation through `runAgencyJudge`).
 */
export async function _evalJudge(
  goal: string,
  recordPathA: string,
  recordPathB: string,
): Promise<PairwiseVerdict> {
  return judgePairwise(goal, recordPathA, recordPathB);
}

/**
 * Stdlib binding for suite-aware eval judging. Compares two eval run
 * directories by task id and returns the suite verdict produced by the core
 * judgeSuite helper.
 */
export async function _evalJudgeSuite(
  runA: string,
  runB: string,
  tasks: EvalTask[],
  samples: number,
  confidenceThreshold: number,
  marginThreshold: number,
  positionBias: string,
  judge: (args: JudgeSuiteArgs) => Promise<SuiteVerdict> = judgeSuite,
): Promise<SuiteVerdict> {
  if (positionBias !== "swap" && positionBias !== "none") {
    throw new Error('positionBias must be "swap" or "none"');
  }
  return judge({
    runA,
    runB,
    tasks,
    policy: { samples, confidenceThreshold, marginThreshold, positionBias },
  });
}

/**
 * Stdlib binding for `agency.eval.optimize`. This deliberately does not
 * install any approval handler; callers decide which handlers are in scope.
 *
 * Mirrors the `agency eval optimize` CLI: exactly one of `tasks` or `goal`
 * selects the suite, a goal desugars through `taskFromGoal()`, and a
 * candidate is accepted iff the judge suite returns winner `B`.
 */
export async function _optimize(
  config: AgencyConfigLike,
  entryFile: string,
  workingDir: string,
  node: string,
  tasks: EvalTask[],
  goal: string,
  iterations: number,
  samples: number,
  confidenceThreshold: number,
  marginThreshold: number,
  runsDir: string,
  runId: string,
  mutatorModel: string,
  writeback: boolean,
  verbosity: string,
  loop: typeof optimizeLoop = optimizeLoop,
): Promise<OptimizeResult> {
  const hasTasks = tasks.length > 0;
  const hasGoal = goal !== "";
  if (hasTasks === hasGoal) {
    throw new Error("Provide exactly one of --tasks or --goal");
  }
  if (verbosity !== "silent" && verbosity !== "default") {
    throw new Error('verbosity must be "silent" or "default"');
  }
  const selectedTasks = hasGoal ? [taskFromGoal(goal)] : tasks;
  const resolvedEntryFile = path.resolve(workingDir || ".", entryFile);
  const targetSet = discoverOptimizeTargets(resolvedEntryFile);
  const reporter = createOptimizeReporter(verbosity as OptimizeVerbosity);
  return loop({
    runtime: {
      config,
      tasks: selectedTasks,
      tasksSource: hasGoal ? "inline:goal" : "stdlib:tasks",
    },
    target: {
      entryFile: targetSet.entryFile,
      node,
      targetSet,
      workingDir: targetSet.baseDir,
      writeback,
    },
    policy: { iterations, mutatorModel: mutatorModel || undefined },
    judgePolicy: { samples, confidenceThreshold, marginThreshold, positionBias: "swap" },
    artifacts: { runsDir: path.resolve(runsDir), runId: runId || nanoid() },
  }, { reporter });
}

type AgencyConfigLike = OptimizeLoopConfig["runtime"]["config"];
