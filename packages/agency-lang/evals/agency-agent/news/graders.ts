import { grader } from "agency-lang/eval";

function runDate(record: { startedAtMs: number }): string {
  return new Date(record.startedAtMs).toISOString().slice(0, 10); // "2026-08-19"
}

export default [
  grader(({ record }) => record.durationMs < 1000 * 60 * 5, { name: "under-5min", mustPass: true }),

  grader(
    ({ judge, record }) =>
      judge({
        goal: `lists news headlines from ${runDate(record)}, not from an earlier or later date`,
      }),
    { name: "is-today" },
  ),

  grader(({ judge }) => judge({ goal: "returns a list of top news headlines" }), {
    name: "headlines",
  }),
];
