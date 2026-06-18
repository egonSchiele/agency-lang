import * as fs from "fs";

import type { SuiteVerdict } from "@/eval/judge/types.js";
import { selectFinalResponse } from "@/eval/judge/selectFinalResponse.js";
import { formatDiff } from "@/utils/diff.js";
import { color } from "@/utils/termcolors.js";
import type { OptimizeAppliedChange, OptimizeMutationDiagnostic } from "./sourceMutator.js";
import type { OptimizeTarget, OptimizeTargetSet } from "./targets.js";
import type { OptimizeDecision, OptimizeResult } from "./types.js";

export type OptimizeVerbosity = "silent" | "default";

/**
 * Presentation boundary for the pointwise optimizers (greedy, GEPA). They speak
 * in a scalar objective + decision per iteration rather than the pairwise
 * judge's win counts, so they get their own reporter shape. Same silent/default
 * gating as the pairwise reporter: `silent` renders nothing.
 */
export type PointwiseReporter = {
  runStarted(args: { optimizer: string; runId: string; targets: OptimizeTarget[]; inputCount: number; iterations: number }): void;
  baselineScored(args: { objective: number }): void;
  iterationDecided(args: {
    iter: number;
    total: number;
    decision: OptimizeDecision;
    objective?: number;
    rationale?: string;
    changes?: OptimizeAppliedChange[];
    diagnostics?: OptimizeMutationDiagnostic[];
    durationMs?: number;
  }): void;
  /** Free-form, verbosity-gated line for optimizer-specific detail (e.g. which parent GEPA sampled). */
  note(message: string): void;
  runFinished(args: {
    result: OptimizeResult;
    initialTargets: OptimizeTarget[];
    finalTargets: OptimizeTarget[];
    durationMs: number;
  }): void;
};

function decisionTag(decision: OptimizeDecision): string {
  if (decision === "accepted") return color.green("accepted");
  if (decision === "validation-failed") return color.red("invalid ");
  return color.red("rejected");
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One-line summary of why a mutation was rejected at validation. */
export function formatDiagnostics(diagnostics: OptimizeMutationDiagnostic[]): string {
  return diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; ");
}

export function createPointwiseReporter(
  verbosity: OptimizeVerbosity,
  log: (line: string) => void = (line) => console.error(line),
): PointwiseReporter {
  if (verbosity === "silent") return SILENT_POINTWISE_REPORTER;
  return {
    runStarted({ optimizer, runId, targets, inputCount, iterations }) {
      log(color.yellow(`\n== optimize ${optimizer} (run ${runId}): ${targets.length} target(s), ${inputCount} input(s), up to ${iterations} iteration(s) ==`));
      for (const target of targets) {
        log(`  - ${color.blue(target.id)} = ${JSON.stringify(truncate(target.value, LIST_VALUE_LIMIT))}`);
      }
    },
    baselineScored({ objective }) {
      log(`  baseline   objective ${objective.toFixed(3)}`);
    },
    iterationDecided({ iter, total, decision, objective, rationale, changes, diagnostics, durationMs }) {
      const obj = objective === undefined ? "" : ` objective ${objective.toFixed(3)}`;
      const timing = durationMs === undefined ? "" : color.dim(` (${formatMs(durationMs)})`);
      log(`  iter ${iter}/${total}  ${decisionTag(decision)}${obj}${timing}`);
      for (const diagnostic of diagnostics ?? []) {
        log(`      ${color.red(`[${diagnostic.code}]`)} ${diagnostic.message}`);
      }
      for (const change of changes ?? []) {
        logValueDiff(log, change.target, change.oldValue, change.newValue);
      }
      if (rationale) log(`      ${color.dim(truncate(rationale, 120))}`);
    },
    note(message) {
      log(`  ${color.dim(message)}`);
    },
    runFinished({ result, initialTargets, finalTargets, durationMs }) {
      log("");
      log(color.yellow("== Optimized variables =="));
      const finalById: Record<string, OptimizeTarget> = {};
      for (const target of finalTargets) finalById[target.id] = target;
      for (const initial of initialTargets) {
        logValueDiff(log, initial.id, initial.value, finalById[initial.id]?.value ?? initial.value);
      }
      log("");
      log(color.yellow(`Complete: champion iteration ${result.championIter}, accepted ${result.acceptedCount}, rejected ${result.rejectedCount}, invalid ${result.validationFailedCount} (${formatMs(durationMs)})`));
    },
  };
}

export const SILENT_POINTWISE_REPORTER: PointwiseReporter = {
  runStarted() { },
  baselineScored() { },
  iterationDecided() { },
  note() { },
  runFinished() { },
};

/** Champion/candidate eval record paths for one input, read lazily when the
 *  reporter renders response diffs. */
export type InputRecordPair = {
  inputId: string;
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
  runStarted(args: { runId: string; targetSet: OptimizeTargetSet; inputCount: number }): void;
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
    records: InputRecordPair[];
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
    runStarted({ runId, targetSet, inputCount }) {
      log(color.yellow(`\n== Run ${runId}: ${targetSet.targets.length} optimize target(s) discovered ==`));
      for (const target of targetSet.targets) {
        log(`  - ${color.blue(target.id)} = ${JSON.stringify(truncate(target.value, LIST_VALUE_LIMIT))}`);
      }
      log(`\nEvaluating baseline on ${inputCount} input(s)`);
    },
    phase({ iter, total, message }) {
      separate(iter);
      log(`Iteration ${iter}/${total}: ${message}`);
    },
    validationFailed({ iter, total, diagnostics }) {
      separate(iter);
      log(color.red(`Iteration ${iter}/${total}: validation failed:`));
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
      const logColor = decision === "accepted" ? color.green : color.red
      log(logColor(`Iteration ${iter}/${total}: ${decision} (candidate wins ${verdict.winsB}, champion wins ${verdict.winsA}, ties ${verdict.ties})`));
      for (const change of changes) {
        logValueDiff(log, change.target, change.oldValue, change.newValue);
      }
      for (const record of records) {
        log(color.blue(`  ~ ${record.inputId} response:`));
        logBlock(log, responseDiff(record, log));
      }
      log(`\n  Rationale: ${rationale}\n`);
    },
    runFinished({ result, writebackApplied, initialTargets, finalTargets }) {
      log("");
      log(color.yellow("== Optimized variables =="));
      const finalById: Record<string, OptimizeTarget> = {};
      for (const target of finalTargets) finalById[target.id] = target;
      for (const initial of initialTargets) {
        logValueDiff(log, initial.id, initial.value, finalById[initial.id]?.value ?? initial.value);
      }
      log("");
      log(color.yellow(`Complete: champion iteration ${result.championIter}, accepted ${result.acceptedCount}, rejected ${result.rejectedCount}, validation failed ${result.validationFailedCount}`));
      log(`Artifacts: ${result.runDir}`);
      if (writebackApplied) log(color.green("\nChampion written back to source files.\n"));
    },
  };
}

export const SILENT_OPTIMIZE_REPORTER: OptimizeReporter = {
  runStarted() { },
  phase() { },
  validationFailed() { },
  iterationRejected() { },
  iterationDecided() { },
  runFinished() { },
};

/**
 * Renders one variable's old → new value as an indented, colored,
 * line-based diff. Identical values come out dimmed with no +/- markers,
 * which is exactly `formatDiff`'s behavior for equal inputs.
 */
function logValueDiff(log: (line: string) => void, target: string, oldValue: string, newValue: string): void {
  log(color.blue(`  ~ ${target}:`));
  logBlock(log, formatDiff(truncate(oldValue, DIFF_VALUE_LIMIT), truncate(newValue, DIFF_VALUE_LIMIT)));
}

function responseDiff(record: InputRecordPair, log: (line: string) => void): string {
  const championResponse = readResponse(record.championRecordPath, log);
  const candidateResponse = readResponse(record.candidateRecordPath, log);
  if (championResponse === null && candidateResponse === null) return color.red("(both responses missing)");
  if (championResponse === null) return color.red(`(champion response missing)\n${truncate(candidateResponse ?? "", DIFF_VALUE_LIMIT)}`);
  if (candidateResponse === null) return color.red(`(candidate response missing)\n${truncate(championResponse, DIFF_VALUE_LIMIT)}`);
  return formatDiff(truncate(championResponse, DIFF_VALUE_LIMIT), truncate(candidateResponse, DIFF_VALUE_LIMIT));
}

function readResponse(recordPath: string | undefined, log: (line: string) => void): string | null {
  if (!recordPath || !fs.existsSync(recordPath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const response = selectFinalResponse(record);
    return response.missing ? null : response.text;
  } catch (error) {
    // Route through the injected logger so callers that capture or
    // redirect reporter output never see stray stderr writes.
    log(`  (failed to read eval record ${recordPath}: ${error instanceof Error ? error.message : String(error)})`);
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
