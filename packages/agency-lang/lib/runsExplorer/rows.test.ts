import { describe, expect, it } from "vitest";

import { applyInputPatch, buildRunRow, recomputeRunAggregates, type RunRow } from "./rows.js";
import type { EvalRunPhaseOne } from "./readRunSummary.js";
import type { Source } from "./sources.js";

const source: Source = { kind: "runDir", dir: "/runs/r1" };

function gradedPhaseOne(): EvalRunPhaseOne {
  return {
    summary: {
      runId: "r1",
      runDir: "/runs/r1",
      agentLabel: "/abs/regex.agency:main",
      okCount: 2,
      errorCount: 0,
      inputs: [
        {
          inputId: "t1", status: "success", statelogPath: "/runs/r1/inputs/t1/agent/statelog.jsonl",
          evalRecordPath: "/runs/r1/inputs/t1/agent/eval-record.json", workdirPath: "",
          metrics: { costUsd: 1.25, durationMs: 60_000, startedAtMs: 1_000_000, models: ["sonnet"], agentName: "regex-log" },
        },
        {
          inputId: "t2", status: "success", statelogPath: "/runs/r1/inputs/t2/agent/statelog.jsonl",
          evalRecordPath: "/runs/r1/inputs/t2/agent/eval-record.json", workdirPath: "",
          metrics: { costUsd: 0.75, durationMs: 120_000, startedAtMs: 1_030_000, models: ["sonnet", "opus"] },
        },
      ],
      grading: {
        graders: ["g"], objective: 0.9, gatesPassed: true,
        perInput: [
          { inputId: "t1", objective: 1.0, gatesPassed: true },
          { inputId: "t2", objective: 0.8, gatesPassed: false },
        ] as never,
      },
    },
    config: {
      runId: "r1",
      startedAt: "2026-08-01T10:00:00.000Z",
      provenance: {
        inputsSource: { source: "suites/bench.json" },
        files: {},
        agent: { command: "claude -p {task}", harnessVersion: "0" },
      },
    },
    warnings: [],
  };
}

describe("buildRunRow", () => {
  it("builds a complete row from a modern summary alone", () => {
    const built = buildRunRow(gradedPhaseOne(), source);

    expect(built.backfillInputIds).toEqual([]);
    const row = built.row;
    expect(row.key).toBe("/runs/r1");
    expect(row.agent).toBe("regex-log");
    expect(row.suite).toBe("bench");
    expect(row.score).toBe(0.9);
    expect(row.gatesPassed).toBe(true);
    expect(row.status).toBe("ok");
    expect(row.costUsd).toBeCloseTo(2.0);
    expect(row.models).toEqual(["sonnet", "opus"]);
    expect(row.backfilled).toBe(true);
  });

  it("wall time is the envelope over tests, not the sum of durations", () => {
    const row = buildRunRow(gradedPhaseOne(), source).row;
    expect(row.wallMs).toBe(1_030_000 + 120_000 - 1_000_000);
  });

  it("per-test rows carry grades matched by input id", () => {
    const row = buildRunRow(gradedPhaseOne(), source).row;
    expect(row.tests.map((t) => [t.inputId, t.score, t.gatesPassed])).toEqual([
      ["t1", 1.0, true],
      ["t2", 0.8, false],
    ]);
  });

  it("inputs without metrics are named for backfill and null out aggregates", () => {
    const phaseOne = gradedPhaseOne();
    delete (phaseOne.summary.inputs[1] as { metrics?: unknown }).metrics;

    const built = buildRunRow(phaseOne, source);

    expect(built.backfillInputIds).toEqual(["t2"]);
    expect(built.row.backfilled).toBe(false);
    expect(built.row.costUsd).toBeCloseTo(1.25);
    expect(built.row.tests[1].costUsd).toBeNull();
  });

  it("an errored input makes the run partial when another succeeded", () => {
    const phaseOne = gradedPhaseOne();
    phaseOne.summary.inputs[1].status = "error";

    const built = buildRunRow(phaseOne, source);

    expect(built.row.status).toBe("partial");
    expect(built.row.tests[1].status).toBe("failed");
    expect(built.backfillInputIds).toContain("t2");
  });
});

describe("applyInputPatch + recomputeRunAggregates", () => {
  it("a backfill patch updates the test, re-resolves the agent, and recomputes aggregates", () => {
    const phaseOne = gradedPhaseOne();
    delete (phaseOne.summary.inputs[0] as { metrics?: unknown }).metrics;
    delete (phaseOne.summary.inputs[1] as { metrics?: unknown }).metrics;
    const row: RunRow = buildRunRow(phaseOne, source).row;
    expect(row.agent).toBe("regex.agency");

    applyInputPatch(row, "t1", {
      costUsd: 3.0, durationMs: 60_000, startedAtMs: 2_000_000,
      models: ["opus"], agentName: "patched-agent", warnings: ["torn line"],
    });
    recomputeRunAggregates(row);

    expect(row.tests[0].costUsd).toBe(3.0);
    expect(row.agent).toBe("patched-agent");
    expect(row.costUsd).toBeCloseTo(3.0);
    expect(row.models).toContain("opus");
    expect(row.warnings).toContain("torn line");
  });
});
