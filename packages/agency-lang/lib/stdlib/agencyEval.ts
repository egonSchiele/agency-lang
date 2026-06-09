import * as fs from "fs";

import { nanoid } from "nanoid";

import { extractEvalRecord } from "../eval/extract.js";
import { readAllEvents } from "../eval/parseJsonl.js";
import {
  initializeEvalRun,
  prepareEvalRunTask,
  recordEvalRunTaskError,
  recordEvalRunTaskSuccess,
  shouldExtractStatelog,
  writeEvalRunSummary,
  type EvalRunState,
  type PreparedEvalRunTask,
} from "../eval/runArtifacts.js";
import type { EvalRunResult, EvalRunTask, EvalRunTaskResult } from "../eval/runTypes.js";

export type AgencyEvalRunState = EvalRunState & {
  tasks: EvalRunTask[];
  results: EvalRunTaskResult[];
};

export function _initializeEvalRun(
  compiled: { moduleId: string },
  tasks: EvalRunTask[],
  node: string,
  runsDir: string,
  runId: string,
  continueOnError: boolean,
): AgencyEvalRunState {
  const resolvedRunId = runId || nanoid();
  const state = initializeEvalRun({
    runId: resolvedRunId,
    runsDir,
    agent: `${compiled.moduleId}:${node}`,
    tasksSource: "stdlib:evalRun",
    tasks,
    continueOnError,
    startedAt: new Date(),
  });
  return { ...state, tasks, results: [] };
}

export function _prepareEvalRunTask(state: AgencyEvalRunState, task: EvalRunTask): PreparedEvalRunTask {
  return prepareEvalRunTask(state, task);
}

export async function _extractEvalRunTask(_state: AgencyEvalRunState, prepared: PreparedEvalRunTask): Promise<boolean> {
  if (!shouldExtractStatelog(prepared.statelogPath)) return false;
  const events = await readAllEvents(prepared.statelogPath);
  const record = extractEvalRecord(events, prepared.statelogPath);
  fs.writeFileSync(prepared.evalRecordPath, JSON.stringify(record, null, 2));
  return true;
}

export function _recordEvalRunTaskError(
  state: AgencyEvalRunState,
  preparedOrTask: PreparedEvalRunTask | EvalRunTask,
  errorMessage: string,
): EvalRunTaskResult {
  const result = recordEvalRunTaskError(preparedOrTask, errorMessage);
  state.results.push(result);
  return result;
}

export function _recordEvalRunTaskSuccess(
  state: AgencyEvalRunState,
  prepared: PreparedEvalRunTask,
): EvalRunTaskResult {
  const result = recordEvalRunTaskSuccess(prepared);
  state.results.push(result);
  return result;
}

export function _finishEvalRun(state: AgencyEvalRunState): EvalRunResult {
  return writeEvalRunSummary(state, state.results);
}

export function _formatEvalRunFailure(value: any): string {
  const candidate = value?.error?.message ?? value?.value?.message ?? value?.message ?? value?.value ?? value;
  return typeof candidate === "string" ? candidate : JSON.stringify(candidate);
}
