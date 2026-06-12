import * as fs from "fs";

import type { SuiteVerdict } from "@/eval/judge/types.js";
import { selectFinalResponse } from "@/eval/judge/selectFinalResponse.js";
import { formatDiff } from "@/utils/diff.js";

import type { OptimizeAppliedChange, OptimizeMutationDiagnostic } from "./sourceMutator.js";
import type { OptimizeTarget, OptimizeTargetSet } from "./targets.js";
import type { OptimizeResult } from "./types.js";

export type OptimizeVerbosity = "silent" | "default";

/** Champion/candidate eval record paths for one task, read lazily when the
 *  reporter renders response diffs. */
export type TaskRecordPair = {
  taskId: string;
  championRecordPath?: string;
  candidateRecordPath?: string;
};

/**
 * Presentation boundary for the optimize loop. The loop emits semantic
 * events; reporters decide what (if anything) to render. Silent renders
 * nothing; default renders the discovered-target gut check, per-iteration
 * progress with colored value and response diffs, and a final summary of
 * every optimized variable's start and end value.
 */
export type OptimizeReporter = {
  runStarted(args: { runId: string; targetSet: OptimizeTargetSet; taskCount: number }): void;
  phase(args: { iter: number; total: number; message: string }): void;
  validationFailed(args: { iter: number; total: number; diagnostics: OptimizeMutationDiagnostic[] }): void;
  iterationRejected(args: { iter: number; total: number; phase: string; error: string }): void;
  iterationDecided(args: {
    iter: number;
    total: number;
    decision: "accepted" | "rejected";
    verdict: SuiteVerdict;
    changes: OptimizeAppliedChange[];
    rationale: string;
    records: TaskRecordPair[];
  }): void;
  runFinished(args: {
    result: OptimizeResult;
    writebackApplied: boolean;
    initialTargets: OptimizeTarget[];
    finalTargets: OptimizeTarget[];
  }): void;
};

const LIST_VALUE_LIMIT = 60;
const DIFF_VALUE_LIMIT = 1000;

export function createOptimizeReporter(
  verbosity: OptimizeVerbosity,
  log: (line: string) => void = (line) => console.error(line),
): OptimizeReporter {
  if (verbosity === "silent") return SILENT_OPTIMIZE_REPORTER;

  // Tracks the current iteration so each one starts after a blank line.
  let currentIter = 0;
  const separate = (iter: number): void => {
    if (iter === currentIter) return;
    currentIter = iter;
    log("");
  };

  return {
    runStarted({ runId, targetSet, taskCount }) {
      log(`Run ${runId}: ${targetSet.targets.length} optimize target(s) discovered:`);
      for (const target of targetSet.targets) {
        log(`  - ${target.id} = ${JSON.stringify(truncate(target.value, LIST_VALUE_LIMIT))}`);
      }
      log(`Evaluating baseline on ${taskCount} task(s)`);
    },
    phase({ iter, total, message }) {
      separate(iter);
      log(`Iteration ${iter}/${total}: ${message}`);
    },
    validationFailed({ iter, total, diagnostics }) {
      separate(iter);
      log(`Iteration ${iter}/${total}: validation failed:`);
      for (const diagnostic of diagnostics) {
        log(`  - [${diagnostic.code}] ${diagnostic.message}`);
      }
    },
    iterationRejected({ iter, total, phase, error }) {
      separate(iter);
      log(`Iteration ${iter}/${total}: rejected during ${phase} (${error})`);
    },
    iterationDecided({ iter, total, decision, verdict, changes, rationale, records }) {
      separate(iter);
      log(`Iteration ${iter}/${total}: ${decision} (candidate wins ${verdict.winsB}, champion wins ${verdict.winsA}, ties ${verdict.ties})`);
      for (const change of changes) {
        logValueDiff(log, change.target, change.oldValue, change.newValue);
      }
      log(`  rationale: ${rationale}`);
      for (const record of records) {
        log(`  ${record.taskId} response:`);
        logBlock(log, responseDiff(record));
      }
    },
    runFinished({ result, writebackApplied, initialTargets, finalTargets }) {
      log("");
      log("Optimized variables:");
      const finalById: Record<string, OptimizeTarget> = {};
      for (const target of finalTargets) finalById[target.id] = target;
      for (const initial of initialTargets) {
        logValueDiff(log, initial.id, initial.value, finalById[initial.id]?.value ?? initial.value);
      }
      log("");
      log(`Complete: champion iteration ${result.championIter}, accepted ${result.acceptedCount}, rejected ${result.rejectedCount}, validation failed ${result.validationFailedCount}`);
      log(`Artifacts: ${result.runDir}`);
      if (writebackApplied) log("Champion written back to source files");
    },
  };
}

export const SILENT_OPTIMIZE_REPORTER: OptimizeReporter = {
  runStarted() {},
  phase() {},
  validationFailed() {},
  iterationRejected() {},
  iterationDecided() {},
  runFinished() {},
};

/**
 * Renders one variable's old → new value as an indented, colored,
 * line-based diff. Identical values come out dimmed with no +/- markers,
 * which is exactly `formatDiff`'s behavior for equal inputs.
 */
function logValueDiff(log: (line: string) => void, target: string, oldValue: string, newValue: string): void {
  log(`  ~ ${target}:`);
  logBlock(log, formatDiff(truncate(oldValue, DIFF_VALUE_LIMIT), truncate(newValue, DIFF_VALUE_LIMIT)));
}

function responseDiff(record: TaskRecordPair): string {
  const championResponse = readResponse(record.championRecordPath);
  const candidateResponse = readResponse(record.candidateRecordPath);
  if (championResponse === null && candidateResponse === null) return "(both responses missing)";
  if (championResponse === null) return `(champion response missing)\n${truncate(candidateResponse ?? "", DIFF_VALUE_LIMIT)}`;
  if (candidateResponse === null) return `(candidate response missing)\n${truncate(championResponse, DIFF_VALUE_LIMIT)}`;
  return formatDiff(truncate(championResponse, DIFF_VALUE_LIMIT), truncate(candidateResponse, DIFF_VALUE_LIMIT));
}

function readResponse(recordPath?: string): string | null {
  if (!recordPath || !fs.existsSync(recordPath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const response = selectFinalResponse(record);
    return response.missing ? null : response.text;
  } catch (error) {
    console.error(`failed to read eval record ${recordPath}:`, error);
    return null;
  }
}

function logBlock(log: (line: string) => void, block: string): void {
  for (const line of block.split("\n")) {
    log(`      ${line}`);
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}
