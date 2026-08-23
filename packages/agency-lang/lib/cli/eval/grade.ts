import * as fs from "fs";

import type { AgencyConfig } from "@/config.js";
import { batchStatisticsByBatch, type BatchStatistics } from "@/eval/batchStatistics.js";
import { gradeSuite } from "@/eval/grading/gradeSuite.js";
import type { EvalRunGrading } from "@/eval/runTypes.js";
import { findRunDirectories, uniqueRunDirectories } from "@/runDirectory/findRuns.js";
import { summarizeRunDirectory } from "@/runDirectory/list.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import type { GraderSource } from "@/eval/grading/gradeRun.js";

import { loadSuite } from "./run.js";

export type EvalGradeOptions = {
  /** Grade with each test's CURRENT graders from this suite (a file, a
   *  directory, or a git source), matched to runs by test id, instead of the
   *  copy each run directory stored. Improve a grader, re-score old runs. */
  suite?: string;
  /** Judge every trace against this goal with the bundled goal judge (a test's
   *  own recorded goal still wins). Not combined with `suite`: the suite's
   *  graders bring their own criteria, and `--goal` names the criterion. */
  goal?: string;
  /** Also write the grading summary here, as JSON. */
  out?: string;
  /** Grade up to this many run directories at once (default 1). Judge calls
   *  are LLM calls, so a big group grades much faster in parallel. */
  parallel?: number;
  /** Called once per graded run directory, in completion order — the CLI's
   *  progress line. Omitted (tests, programmatic use) = silent. */
  progress?: (message: string) => void;
  config?: AgencyConfig;
};

/** The per-batch trial statistics over the graded directories, read back
 *  after grading so the effective scores are the ones just written. A
 *  directory that is not a run (no trace, no run row) contributes nothing;
 *  batches of one trial are left out, the run blocks already say it all. */
function trialBatches(runDirs: readonly string[]): BatchStatistics[] {
  const summaries = runDirs.flatMap((dir) => {
    const summary = summarizeRunDirectory(
      readRunDirectory(dir, { reportWarning: (message) => console.warn(message) }),
    );
    return summary === null ? [] : [summary];
  });
  return batchStatisticsByBatch(summaries).filter((batch) => batch.trials > 1);
}

/** One graded run directory and the mean over them all. */
export type EvalGradeResult = {
  runs: { dir: string; grading: EvalRunGrading }[];
  /** Mean objective over the runs graded. */
  mean: number;
  /** Total LLM spend of this pass's judge calls, in USD. */
  judgeCostUsd: number;
  /** Every run passed its gates. */
  gatesPassed: boolean;
  /** Trial statistics for each selected batch that ran more than one trial,
   *  in the order the batches were met. Unrelated batches never merge. */
  batches: BatchStatistics[];
};

/** The command's own preconditions, checked before anything loads: the two
 *  ways of saying "judge against this" are exclusive, and the targets must
 *  hold run directories (a bare statelog copied into a folder is the common
 *  miss). Returns canonical run directories to grade, duplicates removed by
 *  physical identity: `eval grade runs/suite runs/suite/a` grades `a` once. */
export function validateGradeTarget(targets: string[], opts: EvalGradeOptions): string[] {
  if (opts.suite !== undefined && opts.goal !== undefined) {
    throw new Error(
      "Provide only one of --suite or --goal: the suite's graders carry their own criteria " +
        "(give LlmJudge a goal in a test's graders.ts instead).",
    );
  }
  return uniqueRunDirectories(findRunDirectories(targets));
}

/** Where `eval grade` takes each run's graders from: the suite named by
 *  `--suite`, else the copy the run directory stored. */
export function graderSourceFor(opts: EvalGradeOptions, config: AgencyConfig): GraderSource {
  if (opts.suite === undefined) {
    return { kind: "snapshot" };
  }
  const loaded = loadSuite({
    selection: "suite",
    source: opts.suite,
    cacheRoot: config.eval?.sourceCacheRoot,
  });
  return { kind: "suite", tests: loaded.tests };
}

/**
 * Score run directories, or every run directory in groups. Never re-executes
 * the agent. Each run gets its own grading pass, appended to ITS
 * `annotations.jsonl` — a re-grade sits beside the earlier ones, never over
 * them.
 */
export async function evalGrade(
  targets: string[],
  opts: EvalGradeOptions,
): Promise<EvalGradeResult> {
  const config = opts.config ?? {};
  const runDirs = validateGradeTarget(targets, opts);
  const graders = graderSourceFor(opts, config);

  // A bounded worker pool over run directories; slots keep the report in
  // walk order however completion interleaves. Each directory is one
  // gradeSuite call (its own pass id and its own judge-cost meter).
  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));
  const slots: (EvalGradeResult["runs"][number] & { judgeCostUsd: number })[] = new Array(
    runDirs.length,
  );
  let nextIndex = 0;
  let doneCount = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      const dir = runDirs[index];
      if (dir === undefined) return;
      const startedAt = Date.now();
      const { grading, judgeCostUsd } = await gradeSuite(dir, graders, config, {
        defaultGoal: opts.goal,
      });
      slots[index] = { dir, grading, judgeCostUsd };
      doneCount += 1;
      opts.progress?.(
        `graded ${doneCount}/${runDirs.length} ${dir} — objective ${grading.objective.toFixed(3)}` +
          ` ($${judgeCostUsd.toFixed(2)}, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, runDirs.length) }, () => worker()));
  const runs: EvalGradeResult["runs"] = slots.map(({ dir, grading }) => ({ dir, grading }));
  const result: EvalGradeResult = {
    runs,
    mean: runs.reduce((sum, run) => sum + run.grading.objective, 0) / runs.length,
    judgeCostUsd: slots.reduce((sum, slot) => sum + slot.judgeCostUsd, 0),
    gatesPassed: runs.every((run) => run.grading.gatesPassed),
    batches: trialBatches(runDirs),
  };

  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2));
  }
  return result;
}
