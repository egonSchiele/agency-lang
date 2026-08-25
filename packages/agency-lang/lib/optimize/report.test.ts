import { describe, expect, it } from "vitest";
import { renderReport } from "./report.js";
import type { OptimizeResult } from "./types.js";

const result: OptimizeResult = {
  runId: "r1",
  runDir: "/runs/r1",
  championIter: 2,
  championFiles: { "agent.agency": "node main() {}\n" },
  acceptedCount: 1,
  rejectedCount: 1,
  validationFailedCount: 0,
  iterations: [
    { iter: 0, decision: "baseline" },
    { iter: 1, decision: "rejected", detail: "no improvement", objective: 0.4 },
    { iter: 2, decision: "accepted", objective: 0.75, validationObjective: 0.7 },
  ],
  championBreakdown: [
    {
      inputId: "brazil",
      output: "area is 8.5M km²",
      objective: 0.2,
      gatesPassed: true,
      grades: [
        {
          grader: "goal",
          kind: "scalar",
          value: 0.2,
          feedback: "off-topic; gives area not capital",
        },
      ],
    },
  ],
};

describe("renderReport", () => {
  it("includes the run id, champion, decision counts, and per-iteration table", () => {
    const md = renderReport(result, { optimizer: "greedy", graders: ["goal"] });
    expect(md).toContain("# Optimize run r1");
    expect(md).toContain("greedy");
    expect(md).toContain("Champion: iteration 2");
    expect(md).toContain("accepted: 1");
    expect(md).toMatch(/\| 1 \| rejected \| 0.400 \|  \| no improvement \|/);
    expect(md).toMatch(/\| 2 \| accepted \| 0.750 \| 0.700 \|  \|/);
    const costed = renderReport(
      { ...result, cost: { agentUsd: 0.24, gradingUsd: 0.6, mutatorUsd: 0.15, totalUsd: 0.99 } },
      { optimizer: "greedy", graders: ["goal"] },
    );
    expect(costed).toContain("- Cost: $0.99 (agent $0.24, grading $0.60, mutator $0.15)");
  });

  it("renders the champion grade breakdown so reward-hacking is visible", () => {
    const md = renderReport(result, { optimizer: "greedy", graders: ["goal"] });
    expect(md).toContain("## Champion grades");
    expect(md).toContain("brazil");
    expect(md).toContain("off-topic; gives area not capital");
  });
});
