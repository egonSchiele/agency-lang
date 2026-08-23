import type { RunSummary } from "@/runDirectory/list.js";

/**
 * Statistics over one batch: one suite invocation where every test ran the
 * same number of trials. A test's mean and standard error come from its
 * trials; the batch's accuracy is the mean over every scored run, and its
 * standard error is taken over the per-trial batch means, paired by trial
 * index (trial 1 of every test is one sample), the way a leaderboard reports
 * "accuracy ± SE over k trials". Nothing here is stored: it is recomputed
 * from run summaries wherever they live.
 */
export type TestStatistics = {
  testId: string;
  trials: number;
  /** Mean score over the scored trials; null when none has a score. */
  mean: number | null;
  /** Sample standard deviation / √n; null below two scored trials. */
  standardError: number | null;
  meanCostUsd: number;
  meanDurationMs: number;
};

export type BatchStatistics = {
  /** The shared batch id; null for a lone run from before batches existed. */
  batch: string | null;
  tests: TestStatistics[];
  trials: number;
  /** Mean score over every scored run in the batch; null when none has one. */
  accuracy: number | null;
  /** Sample standard deviation of the per-trial batch means / √k; null below two trials. */
  standardError: number | null;
  totalCostUsd: number;
  totalDurationMs: number;
};

/** Split runs into batches by their batch id (a run without one is a batch
 *  of its own), in first-seen order, and compute each batch's statistics. */
export function batchStatisticsByBatch(runs: readonly RunSummary[]): BatchStatistics[] {
  const groups: { batch: string | null; runs: RunSummary[] }[] = [];
  for (const run of runs) {
    const group = run.batch === null ? undefined : groups.find((entry) => entry.batch === run.batch);
    if (group === undefined) {
      groups.push({ batch: run.batch, runs: [run] });
    } else {
      group.runs.push(run);
    }
  }
  return groups.map((group) => batchStatistics(group.runs));
}

/** Statistics for exactly one complete batch. Refuses an empty input, runs
 *  from different batches, more than one run without a batch id, and any
 *  incomplete trial grid: every test must have trials exactly `1..k` for one
 *  `k`, so a pairing by trial index is always between real trials. */
export function batchStatistics(runs: readonly RunSummary[]): BatchStatistics {
  if (runs.length === 0) {
    throw new Error("batchStatistics: no runs");
  }
  const batch = sharedBatchId(runs);
  const tests = groupByTest(runs);
  const trials = completeTrialCount(tests);
  const scored = runs.filter((run) => run.score !== null);
  const trialMeans = trialIndices(trials).flatMap((trial) => {
    const ofTrial = scored.filter((run) => trialOf(run) === trial);
    return ofTrial.length === 0 ? [] : [meanOf(ofTrial.map((run) => run.score ?? 0))];
  });
  return {
    batch,
    tests: tests.map(testStatistics),
    trials,
    accuracy: scored.length === 0 ? null : meanOf(scored.map((run) => run.score ?? 0)),
    standardError: standardErrorOf(trialMeans),
    totalCostUsd: sumOf(runs.map((run) => run.costUsd)),
    totalDurationMs: sumOf(runs.map((run) => run.durationMs)),
  };
}

type TestRuns = { testId: string; runs: RunSummary[] };

function sharedBatchId(runs: readonly RunSummary[]): string | null {
  const ids: (string | null)[] = [];
  for (const run of runs) {
    if (!ids.includes(run.batch)) {
      ids.push(run.batch);
    }
  }
  if (ids.length > 1) {
    const shown = ids.map((id) => (id === null ? "(none)" : id)).join(", ");
    throw new Error(`batchStatistics: runs from different batches (${shown})`);
  }
  if (ids[0] === null && runs.length > 1) {
    throw new Error("batchStatistics: a run without a batch id is a batch of its own");
  }
  return ids[0];
}

function groupByTest(runs: readonly RunSummary[]): TestRuns[] {
  const tests: TestRuns[] = [];
  for (const run of runs) {
    const testId = run.testId ?? run.traceId;
    const test = tests.find((entry) => entry.testId === testId);
    if (test === undefined) {
      tests.push({ testId, runs: [run] });
    } else {
      test.runs.push(run);
    }
  }
  return tests;
}

/** The one trial count every test has, after checking each test's indices
 *  are exactly 1..n and every n is the same. */
function completeTrialCount(tests: readonly TestRuns[]): number {
  for (const test of tests) {
    const indices = test.runs.map(trialOf).sort((left, right) => left - right);
    const expected = trialIndices(indices.length);
    if (indices.some((index, position) => index !== expected[position])) {
      throw new Error(
        `batchStatistics: test ${test.testId}: trial indices ${indices.join(", ")} are not 1..${indices.length}`,
      );
    }
  }
  const counts = tests.map((test) => test.runs.length);
  const first = counts[0];
  const uneven = tests.find((test) => test.runs.length !== first);
  if (uneven !== undefined) {
    throw new Error(
      `batchStatistics: incomplete trial grid: ${tests[0].testId} has ${first} trials, ` +
        `${uneven.testId} has ${uneven.runs.length}`,
    );
  }
  return first;
}

/** A run from before trials were recorded is its test's only trial. */
function trialOf(run: RunSummary): number {
  return run.trial ?? 1;
}

function trialIndices(trials: number): number[] {
  return Array.from({ length: trials }, (_, position) => position + 1);
}

function testStatistics(test: TestRuns): TestStatistics {
  const scores = test.runs.flatMap((run) => (run.score === null ? [] : [run.score]));
  return {
    testId: test.testId,
    trials: test.runs.length,
    mean: scores.length === 0 ? null : meanOf(scores),
    standardError: standardErrorOf(scores),
    meanCostUsd: meanOf(test.runs.map((run) => run.costUsd)),
    meanDurationMs: meanOf(test.runs.map((run) => run.durationMs)),
  };
}

function sumOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function meanOf(values: readonly number[]): number {
  return sumOf(values) / values.length;
}

/** Sample standard deviation over √n; null below two samples. */
function standardErrorOf(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const meanValue = meanOf(values);
  const squared = values.map((value) => (value - meanValue) ** 2);
  const variance = sumOf(squared) / (values.length - 1);
  return Math.sqrt(variance) / Math.sqrt(values.length);
}
