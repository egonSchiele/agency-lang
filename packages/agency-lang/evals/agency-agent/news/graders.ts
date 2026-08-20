import { grader } from "agency-lang/eval";

function runDate(record: { startedAtMs: number }): string {
  return new Date(record.startedAtMs).toISOString().slice(0, 10); // "2026-08-19"
}

export default [
  grader(({ record }) => record.durationMs < 1000 * 60 * 5, { name: "under-5min", mustPass: true }),

  grader(
    async ({ judge, record }) => {
      const v = await judge({
        goal: `lists news headlines from ${runDate(record)}, not from an earlier or later date`,
      });
      return { score: { kind: "scalar", value: v.score }, feedback: v.reasoning };
    },
    { name: "is-today" },
  ),

  grader(
    async ({ judge }) => {
      const v = await judge({ goal: "returns a list of top news headlines" });
      return { score: { kind: "scalar", value: v.score }, feedback: v.reasoning };
    },
    { name: "headlines" },
  ),
];
