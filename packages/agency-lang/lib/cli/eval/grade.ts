import * as fs from "fs";

import type { AgencyConfig } from "@/config/config.js";
import {
  batchStatisticsByBatchTolerant,
  type BatchStatistics,
  type IncompleteBatch,
} from "@/eval/batchStatistics.js";
import { gradeSuite } from "@/eval/grading/gradeSuite.js";
import type { EvalRunGrading, SuiteTestResult } from "@/eval/runTypes.js";
import { shellInterrupted } from "@/eval/shellCommand.js";
import { findRunDirectories, uniqueRunDirectories } from "@/runDirectory/findRuns.js";
import { summarizeRunDirectory } from "@/runDirectory/list.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";

import type { GraderSource } from "@/eval/grading/gradeRun.js";

import { mapInParallel } from "@/utils/parallelMap.js";

import { formatUsd } from "@/eval/grading/gradeBreakdown.js";

import { formatGradeResult } from "./formatGrade.js";
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
function trialBatches(runDirs: readonly string[]): {
  batches: BatchStatistics[];
  incompleteBatches: IncompleteBatch[];
} {
  const summaries = runDirs.flatMap((dir) => {
    const summary = summarizeRunDirectory(
      readRunDirectory(dir, { reportWarning: (message) => console.warn(message) }),
    );
    return summary === null ? [] : [summary];
  });
  const { batches, incomplete } = batchStatisticsByBatchTolerant(summaries);
  return { batches: batches.filter((batch) => batch.trials > 1), incompleteBatches: incomplete };
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
  /** Batches with no statistics — an uneven trial grid, say — and why. Their
   *  runs are still graded above; only the batch-level numbers are missing. */
  incompleteBatches: IncompleteBatch[];
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
  const runDirs = gradableRunDirs(validateGradeTarget(targets, opts));
  const graders = graderSourceFor(opts, config);

  // Each directory is one gradeSuite call (its own grading pass id and its
  // own judge-cost meter); mapInParallel keeps the report in walk order.
  let doneCount = 0;
  const graded = await mapInParallel(runDirs, opts.parallel ?? 1, async (dir) => {
    const startedAt = Date.now();
    const { grading, judgeCostUsd } = await gradeSuite(dir, graders, config, {
      defaultGoal: opts.goal,
    });
    // Ctrl-C reached a grader's command. The pass was not recorded, and the
    // remaining directories would only spend money on judges nobody waits for.
    if (shellInterrupted()) {
      throw new Error("eval grade was interrupted; the interrupted run was not graded");
    }
    doneCount += 1;
    opts.progress?.(
      `graded ${doneCount}/${runDirs.length} ${dir} — objective ${grading.objective.toFixed(3)}` +
        ` (${formatUsd(judgeCostUsd)}, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    return { dir, grading, judgeCostUsd };
  });
  const result = gradeResultOf(graded);

  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2));
  }
  return result;
}

/** The run directories `eval grade` will grade: all but those made with
 *  `--no-workdir-snapshot`, each of which is named on stderr. An error when
 *  that leaves nothing. */
function gradableRunDirs(runDirs: string[]): string[] {
  const skipped = runDirs.filter(madeWithoutWorkdir);
  for (const dir of skipped) {
    console.warn(
      `grading: skipping ${dir}: it was run with --no-workdir-snapshot, so its workdir is gone; ` +
        "the grades from `eval run --grade` stand",
    );
  }
  const kept = runDirs.filter((dir) => !skipped.includes(dir));
  if (kept.length === 0) {
    throw new Error(
      "Nothing to grade: every run here was made with --no-workdir-snapshot and cannot be graded again.",
    );
  }
  return kept;
}

/** True for a run made with `eval run --no-workdir-snapshot`. Its workdir
 *  was graded where the agent left it and then removed. Grading it again
 *  would fail every grader that reads the workdir and record those failures
 *  as the run's newest grades, over the real ones. */
export function madeWithoutWorkdir(runDir: string): boolean {
  const snapshot = readRunDirectory(runDir, { reportWarning: () => {} });
  return snapshot.annotationRows.some(
    (row) => row.kind === "run" && row.flags.workdirSnapshot === false,
  );
}

/** The report for a set of graded run directories. Shared by `eval grade`
 *  and `eval run --grade`, so the two print the same thing. */
export function gradeResultOf(
  graded: { dir: string; grading: EvalRunGrading; judgeCostUsd: number }[],
): EvalGradeResult {
  const runs: EvalGradeResult["runs"] = graded.map(({ dir, grading }) => ({ dir, grading }));
  return {
    runs,
    mean: runs.reduce((sum, run) => sum + run.grading.objective, 0) / runs.length,
    judgeCostUsd: graded.reduce((sum, entry) => sum + entry.judgeCostUsd, 0),
    gatesPassed: runs.every((run) => run.grading.gatesPassed),
    ...trialBatches(runs.map((run) => run.dir)),
  };
}

/** The lines `eval run --grade` prints after the suite: the same report
 *  `eval grade` prints, for the tests that were graded. Empty when none was. */
export function inPlaceGradeReport(tests: SuiteTestResult[]): string[] {
  const graded = tests.flatMap((test) =>
    test.grading === undefined
      ? []
      : [{ dir: test.runDir, grading: test.grading, judgeCostUsd: test.judgeCostUsd ?? 0 }],
  );
  if (graded.length === 0) {
    return [];
  }
  // One invocation may hold only part of a batch (`--trial-number`), so a
  // "batch has no statistics" line here would be noise, not news.
  return formatGradeResult({ ...gradeResultOf(graded), incompleteBatches: [] });
}

/**
 * The `agency eval grade` action: progress lines on stderr, the report on
 * stdout. Returns whether every run passed its gates — the caller owns the
 * exit code.
 */
export async function runGradeCommand(paths: string[], opts: EvalGradeOptions): Promise<boolean> {
  const result = await evalGrade(paths, {
    ...opts,
    progress: (message) => process.stderr.write(`${message}\n`),
  });
  for (const line of formatGradeResult(result)) console.log(line);
  return result.gatesPassed;
}
