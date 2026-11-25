import { expect, it } from "vitest";

import { summaryLines, type ListedRun } from "./summary.js";

const run = (latestScore: number | null, costUsd: number): ListedRun =>
  ({ dir: "group/a", summary: { latestScore, costUsd }, scores: [] }) as unknown as ListedRun;

it("shows the score and cost of a job that came back clean", () => {
  expect(
    summaryLines([{ label: "unit-literals", result: { cameBack: true }, run: run(0.75, 2.049) }]),
  ).toEqual(["unit-literals  score 0.750  $2.05"]);
});

it("says a run that came back has no grades", () => {
  expect(summaryLines([{ label: "a", result: { cameBack: true }, run: run(null, 0) }])).toEqual([
    "a  not graded  $0.00",
  ]);
});

it("puts a problem first, and keeps the score and cost of a run that still came back", () => {
  expect(
    summaryLines([
      {
        label: "a",
        result: { cameBack: true, problem: "interrupted, not graded" },
        run: run(null, 1.5),
      },
      {
        label: "b",
        result: { cameBack: true, problem: "the inner eval run exited with code 1" },
        run: run(0.5, 3),
      },
    ]),
  ).toEqual([
    "a  interrupted, not graded  $1.50",
    "b  the inner eval run exited with code 1  score 0.500  $3.00",
  ]);
});

it("shows the first line of what went wrong for a job that brought nothing back", () => {
  const problem = "no run directory came back (exit 137):\nlog tail";
  expect(summaryLines([{ label: "a", result: { cameBack: false, problem } }])).toEqual([
    "a  failed: no run directory came back (exit 137):",
  ]);
});

it("says a job never started, and lines the labels up", () => {
  expect(
    summaryLines([
      { label: "layout-table", result: "not started" },
      { label: "a", result: "not started" },
    ]),
  ).toEqual(["layout-table  not started", "a             not started"]);
});
