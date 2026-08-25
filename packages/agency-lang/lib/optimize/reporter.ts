import { formatDiff } from "@/utils/diff.js";
import { color } from "@/utils/termcolors.js";
import type { OptimizeAppliedChange, OptimizeMutationDiagnostic } from "./sourceMutator.js";
import type { OptimizeTarget } from "./targets.js";
import { formatCost } from "./report.js";
import type { OptimizeDecision, OptimizeResult } from "./types.js";

export type OptimizeVerbosity = "silent" | "default";

/** Presentation boundary for the optimizers. `silent` renders nothing. */
export type PointwiseReporter = {
  runStarted(args: {
    optimizer: string;
    runId: string;
    targets: OptimizeTarget[];
    inputCount: number;
    iterations: number;
  }): void;
  gradingSetup(args: {
    graders: { name: string; describe: string }[];
    firstInput?: { id: string; goal?: string };
  }): void;
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
      log(
        color.yellow(
          `\n== optimize ${optimizer} (run ${runId}): ${targets.length} target(s), ${inputCount} input(s), up to ${iterations} iteration(s) ==`,
        ),
      );
      for (const target of targets) {
        log(
          `  - ${color.blue(target.id)} = ${JSON.stringify(truncate(target.value, LIST_VALUE_LIMIT))}`,
        );
      }
    },
    gradingSetup({ graders, firstInput }) {
      log(color.yellow("  grading:"));
      for (const g of graders) log(`    - ${g.describe}`);
      if (firstInput)
        log(
          color.dim(
            `    first input: ${firstInput.id}${firstInput.goal ? ` — goal: ${truncate(firstInput.goal, 80)}` : ""}`,
          ),
        );
    },
    baselineScored({ objective }) {
      log(`  baseline   objective ${objective.toFixed(3)}`);
    },
    iterationDecided({
      iter,
      total,
      decision,
      objective,
      rationale,
      changes,
      diagnostics,
      durationMs,
    }) {
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
      log(
        color.yellow(
          `Complete: champion iteration ${result.championIter}, accepted ${result.acceptedCount}, rejected ${result.rejectedCount}, invalid ${result.validationFailedCount} (${formatMs(durationMs)})`,
        ),
      );
      if (result.cost) log(color.yellow(`Cost: ${formatCost(result.cost)}`));
    },
  };
}

export const SILENT_POINTWISE_REPORTER: PointwiseReporter = {
  runStarted() {},
  gradingSetup() {},
  baselineScored() {},
  iterationDecided() {},
  note() {},
  runFinished() {},
};

const LIST_VALUE_LIMIT = 60;
const DIFF_VALUE_LIMIT = 1000;

/**
 * Renders one variable's old → new value as an indented, colored,
 * line-based diff. Identical values come out dimmed with no +/- markers,
 * which is exactly `formatDiff`'s behavior for equal inputs.
 */
function logValueDiff(
  log: (line: string) => void,
  target: string,
  oldValue: string,
  newValue: string,
): void {
  log(color.blue(`  ~ ${target}:`));
  logBlock(
    log,
    formatDiff(truncate(oldValue, DIFF_VALUE_LIMIT), truncate(newValue, DIFF_VALUE_LIMIT)),
  );
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
