import { describe, expect, it } from "vitest";
import { renderReport } from "./report.js";
import type { OptimizeResult } from "./types.js";

const result: OptimizeResult = {
  runId: "r1", runDir: "/runs/r1", championIter: 2,
  championFiles: { "agent.agency": "node main() {}\n" },
  acceptedCount: 1, rejectedCount: 1, validationFailedCount: 0,
  iterations: [
    { iter: 0, decision: "baseline", winsA: 0, winsB: 0, ties: 0 },
    { iter: 1, decision: "rejected", winsA: 0, winsB: 0, ties: 0, detail: "no improvement" },
    { iter: 2, decision: "accepted", winsA: 0, winsB: 0, ties: 0 },
  ],
  championBreakdown: [
    { inputId: "brazil", output: "area is 8.5M km²", objective: 0.2, gatesPassed: true,
      grades: [{ grader: "goal", kind: "scalar", value: 0.2, feedback: "off-topic; gives area not capital" }] },
  ],
};

describe("renderReport", () => {
  it("includes the run id, champion, decision counts, and per-iteration table", () => {
    const md = renderReport(result, { optimizer: "greedy", graders: ["goal"] });
    expect(md).toContain("# Optimize run r1");
    expect(md).toContain("greedy");
    expect(md).toContain("Champion: iteration 2");
    expect(md).toContain("accepted: 1");
    expect(md).toMatch(/\| 1 \| rejected \| no improvement \|/);
  });

  it("renders the champion grade breakdown so reward-hacking is visible", () => {
    const md = renderReport(result, { optimizer: "greedy", graders: ["goal"] });
    expect(md).toContain("## Champion grades");
    expect(md).toContain("brazil");
    expect(md).toContain("off-topic; gives area not capital");
  });
});
