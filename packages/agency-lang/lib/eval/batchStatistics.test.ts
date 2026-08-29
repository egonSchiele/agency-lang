import { describe, expect, it } from "vitest";

import type { RunSummary } from "@/runDirectory/list.js";

import {
  batchStatistics,
  batchStatisticsByBatch,
  batchStatisticsByBatchTolerant,
} from "./batchStatistics.js";

type Overrides = Partial<RunSummary>;

let counter = 0;

/** A finished, scored run; any field can be overridden. */
function run(overrides: Overrides): RunSummary {
  counter += 1;
  return {
    traceId: `trace-${counter}`,
    testId: "fib",
    input: null,
    agentName: null,
    agentLabel: null,
    startedAt: null,
    startedAtMs: null,
    endedAt: null,
    durationMs: 1000,
    costUsd: 1,
    llmCalls: 1,
    toolCalls: 0,
    eventCount: 3,
    models: [],
    ended: "ok",
    status: "ok",
    latestScore: 1,
    score: 1,
    gradingPasses: 1,
    gatesPassed: true,
    hasNotes: false,
    labeled: false,
    codeHash: null,
    batch: "b1",
    trial: 1,
    suiteSource: null,
    suiteSha: null,
    ...overrides,
  };
}

describe("batchStatistics", () => {
  it("one trial: means, no standard error, totals", () => {
    const stats = batchStatistics([
      run({ testId: "fib", score: 1, costUsd: 2, durationMs: 100 }),
      run({ testId: "sum", score: 0, costUsd: 3, durationMs: 300 }),
    ]);
    expect(stats).toEqual({
      batch: "b1",
      trials: 1,
      accuracy: 0.5,
      standardError: null,
      totalCostUsd: 5,
      totalDurationMs: 400,
      tests: [
        {
          testId: "fib",
          trials: 1,
          mean: 1,
          standardError: null,
          meanCostUsd: 2,
          meanDurationMs: 100,
        },
        {
          testId: "sum",
          trials: 1,
          mean: 0,
          standardError: null,
          meanCostUsd: 3,
          meanDurationMs: 300,
        },
      ],
    });
  });

  it("three trials of one test: sample standard deviation over the square root of the count", () => {
    const stats = batchStatistics([
      run({ trial: 1, score: 1 }),
      run({ trial: 2, score: 0.5 }),
      run({ trial: 3, score: 0 }),
    ]);
    // scores 1, 0.5, 0: mean 0.5, sample SD 0.5, SE 0.5/√3
    expect(stats.tests[0].mean).toBeCloseTo(0.5);
    expect(stats.tests[0].standardError).toBeCloseTo(0.5 / Math.sqrt(3));
    expect(stats.accuracy).toBeCloseTo(0.5);
    // One test, so the per-trial batch means are the scores themselves.
    expect(stats.standardError).toBeCloseTo(0.5 / Math.sqrt(3));
  });

  it("batch standard error pairs trials by index: [1,0] and [0,1] give trial means [0.5, 0.5] and SE 0", () => {
    const stats = batchStatistics([
      run({ testId: "a", trial: 1, score: 1 }),
      run({ testId: "a", trial: 2, score: 0 }),
      run({ testId: "b", trial: 1, score: 0 }),
      run({ testId: "b", trial: 2, score: 1 }),
    ]);
    expect(stats.accuracy).toBe(0.5);
    expect(stats.standardError).toBe(0);
  });

  it("refuses duplicate or gapped trial indices, naming the test", () => {
    expect(() => batchStatistics([run({ trial: 1 }), run({ trial: 1 })])).toThrow(
      /test fib: trial indices 1, 1 are not 1\.\.2/,
    );
    expect(() => batchStatistics([run({ trial: 1 }), run({ trial: 3 })])).toThrow(
      /test fib: trial indices 1, 3 are not 1\.\.2/,
    );
  });

  it("refuses an uneven grid: every test must have the same trials", () => {
    expect(() =>
      batchStatistics([
        run({ testId: "a", trial: 1 }),
        run({ testId: "a", trial: 2 }),
        run({ testId: "a", trial: 3 }),
        run({ testId: "b", trial: 1 }),
        run({ testId: "b", trial: 2 }),
      ]),
    ).toThrow(/incomplete trial grid: a has 3 trials, b has 2/);
  });

  it("refuses runs from different batches, and more than one run without a batch", () => {
    expect(() => batchStatistics([run({ batch: "b1" }), run({ batch: "b2" })])).toThrow(
      /different batches \(b1, b2\)/,
    );
    expect(() => batchStatistics([run({ batch: null }), run({ batch: "b2" })])).toThrow(
      /different batches/,
    );
    expect(() =>
      batchStatistics([run({ batch: null, trial: null }), run({ batch: null, trial: null })]),
    ).toThrow(/a run without a batch id is a batch of its own/);
    expect(() => batchStatistics([])).toThrow(/no runs/);
  });

  it("a run from before batches and trials existed is one batch of one trial", () => {
    const stats = batchStatistics([run({ batch: null, trial: null, score: 0.25 })]);
    expect(stats).toMatchObject({ batch: null, trials: 1, accuracy: 0.25 });
  });

  it("an unscored run is left out of means but counted in totals; a failed run counts as its zero", () => {
    const stats = batchStatistics([
      run({ testId: "a", trial: 1, score: 1, costUsd: 1 }),
      run({ testId: "a", trial: 2, score: null, latestScore: null, costUsd: 1 }),
      // A run that never wrote a trace: grading's rule scores it 0.
      run({
        testId: "b",
        trial: 1,
        status: "failed",
        ended: "error",
        eventCount: 0,
        score: 0,
        latestScore: null,
        costUsd: 0,
        durationMs: 0,
      }),
      run({ testId: "b", trial: 2, score: 1, costUsd: 1 }),
    ]);
    expect(stats.tests.map((test) => [test.testId, test.mean, test.standardError])).toEqual([
      ["a", 1, null],
      ["b", 0.5, 0.5],
    ]);
    // Scored runs: 1, 0, 1.
    expect(stats.accuracy).toBeCloseTo(2 / 3);
    expect(stats.totalCostUsd).toBe(3);
  });
});

describe("batchStatisticsByBatch", () => {
  it("two batches reusing the same test and trial ids are two groups, in first-seen order", () => {
    const groups = batchStatisticsByBatch([
      run({ batch: "b1", testId: "a", trial: 1, score: 1 }),
      run({ batch: "b2", testId: "a", trial: 1, score: 0 }),
      run({ batch: "b1", testId: "a", trial: 2, score: 1 }),
      run({ batch: "b2", testId: "a", trial: 2, score: 0 }),
    ]);
    expect(groups.map((group) => [group.batch, group.trials, group.accuracy])).toEqual([
      ["b1", 2, 1],
      ["b2", 2, 0],
    ]);
  });

  it("each run without a batch id is its own group", () => {
    const groups = batchStatisticsByBatch([
      run({ batch: null, trial: null, score: 1 }),
      run({ batch: null, trial: null, score: 0 }),
    ]);
    expect(groups.map((group) => [group.batch, group.accuracy])).toEqual([
      [null, 1],
      [null, 0],
    ]);
  });

  it("tolerant variant reports an incomplete batch beside the others' statistics", () => {
    const complete = [run({ batch: "x", testId: "a", trial: 1, score: 1 })];
    const uneven = [
      run({ batch: "y", testId: "a", trial: 1, score: 1 }),
      run({ batch: "y", testId: "a", trial: 2, score: 0 }),
      run({ batch: "y", testId: "b", trial: 1, score: 1 }),
    ];
    const { batches, incomplete } = batchStatisticsByBatchTolerant([...complete, ...uneven]);
    expect(batches.map((batch) => batch.batch)).toEqual(["x"]);
    expect(incomplete).toEqual([
      {
        batch: "y",
        reason: expect.stringMatching(/incomplete trial grid: a has 2 trials, b has 1/),
      },
    ]);
  });
});
