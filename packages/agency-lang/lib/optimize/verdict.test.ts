import { describe, expect, it } from "vitest";

import { buildOptimizeVerdict } from "./verdict.js";
import type { OptimizeTaskVerdict } from "./types.js";

function task(taskId: string, winner: OptimizeTaskVerdict["winner"], confidence: number): OptimizeTaskVerdict {
  return { taskId, winner, confidence, samples: [] };
}

describe("buildOptimizeVerdict", () => {
  it("accepts when confident candidate wins exceed losses by more than threshold", () => {
    const verdict = buildOptimizeVerdict({
      iter: 2,
      championIter: 1,
      judgeSamples: 1,
      acceptThreshold: 0,
      perTask: [task("a", "candidate", 80), task("b", "champion", 80), task("c", "candidate", 70)],
      mutationSummary: "clearer",
    });

    expect(verdict).toMatchObject({ decision: "accepted", wins: 2, losses: 1, ties: 0, margin: 1 });
  });

  it("rejects on equal margin", () => {
    const verdict = buildOptimizeVerdict({
      iter: 2,
      championIter: 1,
      judgeSamples: 1,
      acceptThreshold: 0,
      perTask: [task("a", "candidate", 80), task("b", "champion", 80)],
      mutationSummary: "clearer",
    });

    expect(verdict.decision).toBe("rejected");
    expect(verdict.margin).toBe(0);
  });

  it("counts low-confidence verdicts as ties", () => {
    const verdict = buildOptimizeVerdict({
      iter: 2,
      championIter: 1,
      judgeSamples: 1,
      acceptThreshold: 0,
      perTask: [task("a", "candidate", 49), task("b", "candidate", 80)],
      mutationSummary: "clearer",
    });

    expect(verdict).toMatchObject({ wins: 1, losses: 0, ties: 1, decision: "accepted" });
  });

  it("rejects and warns when no verdict has confident signal", () => {
    const verdict = buildOptimizeVerdict({
      iter: 2,
      championIter: "baseline",
      judgeSamples: 1,
      acceptThreshold: 0,
      perTask: [task("a", "candidate", 20), task("b", "tie", 40)],
      mutationSummary: "clearer",
    });

    expect(verdict).toMatchObject({ decision: "rejected", wins: 0, losses: 0, ties: 2, margin: 0 });
    expect(verdict.warning).toMatch(/no confident signal/i);
  });
});
