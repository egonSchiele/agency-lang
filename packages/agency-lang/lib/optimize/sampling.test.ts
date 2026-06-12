import { describe, expect, it } from "vitest";

import { aggregateSamples, judgeCandidateAgainstChampion } from "./sampling.js";

describe("judgeCandidateAgainstChampion", () => {
  it("alternates argument order and maps winners back to champion/candidate", async () => {
    const calls: Array<[string, string]> = [];
    const verdict = await judgeCandidateAgainstChampion({
      taskId: "task-1",
      goal: "prefer accuracy",
      championRecordPath: "champion.json",
      candidateRecordPath: "candidate.json",
      samples: 2,
      judge: async (_goal, recordA, recordB) => {
        calls.push([recordA, recordB]);
        return { winner: "A", confidence: 80, reasoning: "A wins" };
      },
    });

    expect(calls).toEqual([
      ["champion.json", "candidate.json"],
      ["candidate.json", "champion.json"],
    ]);
    expect(verdict.samples.map((sample) => sample.winner)).toEqual(["champion", "candidate"]);
  });
});

describe("aggregateSamples", () => {
  it("breaks winner-count ties by mean confidence including tie samples for both sides", () => {
    const verdict = aggregateSamples("task-1", [
      { winner: "champion", confidence: 70, reasoning: "champion" },
      { winner: "candidate", confidence: 80, reasoning: "candidate" },
      { winner: "tie", confidence: 100, reasoning: "same" },
    ]);

    expect(verdict.winner).toBe("candidate");
    expect(verdict.confidence).toBeCloseTo(83.33, 1);
  });
});
