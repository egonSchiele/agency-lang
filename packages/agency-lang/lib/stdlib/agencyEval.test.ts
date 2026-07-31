import { describe, expect, it } from "vitest";

import { _evalJudgeSuite } from "./agencyEval.js";

describe("agency eval stdlib helpers", () => {
  it("delegates suite judging to the core judgeSuite helper", async () => {
    const result = await _evalJudgeSuite(
      "run-a",
      "run-b",
      5,
      60,
      1,
      "none",
      async (args) => ({
        verdictVersion: 2,
        generatedAt: "2026-06-11T00:00:00.000Z",
        policy: args.policy,
        winsA: 0,
        winsB: 1,
        ties: 0,
        winner: "B",
        perInput: [],
      }),
    );

    expect(result).toMatchObject({
      winner: "B",
      policy: { samples: 5, confidenceThreshold: 60, marginThreshold: 1, positionBias: "none" },
    });
  });
});
