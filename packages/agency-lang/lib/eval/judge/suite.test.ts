import { describe, expect, it } from "vitest";

import {
  aggregateSuite,
  judgeSuite,
  mapWinnerToOriginal,
  orderForSample,
  reduceSamples,
} from "./suite.js";
import type { JudgeAggregationPolicy, TaskVerdict } from "./types.js";
import type { ReadEvalRunResult } from "@/eval/readRun.js";

const policy: JudgeAggregationPolicy = {
  samples: 3,
  confidenceThreshold: 50,
  marginThreshold: 0,
  positionBias: "swap",
};

describe("judge suite pure helpers", () => {
  it("alternates sample order when position bias is swap", () => {
    expect([0, 1, 2].map((index) => orderForSample(index, "swap"))).toEqual(["AB", "BA", "AB"]);
    expect([0, 1, 2].map((index) => orderForSample(index, "none"))).toEqual(["AB", "AB", "AB"]);
  });

  it("maps BA winners back to original side labels", () => {
    expect(mapWinnerToOriginal("A", "AB")).toBe("A");
    expect(mapWinnerToOriginal("B", "AB")).toBe("B");
    expect(mapWinnerToOriginal("A", "BA")).toBe("B");
    expect(mapWinnerToOriginal("B", "BA")).toBe("A");
    expect(mapWinnerToOriginal("tie", "BA")).toBe("tie");
  });

  it("reduces samples after mapping swapped positions to original sides", () => {
    const verdict = reduceSamples({
      taskId: "task-1",
      goal: "Return Paris",
      inputs: [{ path: "a.json", status: "ok" }, { path: "b.json", status: "ok" }],
      samples: [
        { winner: "A", confidence: 80, reasoning: "first A", order: "AB" },
        { winner: "A", confidence: 70, reasoning: "swapped A", order: "BA" },
      ],
    });

    expect(verdict).toMatchObject({
      taskId: "task-1",
      goal: "Return Paris",
      winner: "tie",
      confidence: 75,
    });
    expect(verdict.samples.map((sample) => sample.winner)).toEqual(["A", "B"]);
  });

  it("aggregates low-confidence task verdicts as ties", () => {
    expect(aggregateSuite([
      taskVerdict("a", "A", 90),
      taskVerdict("b", "B", 90),
      taskVerdict("low", "B", 20),
    ], policy)).toMatchObject({
      verdictVersion: 2,
      winsA: 1,
      winsB: 1,
      ties: 1,
      winner: "tie",
      perTask: [
        { taskId: "a", winner: "A", confidence: 90 },
        { taskId: "b", winner: "B", confidence: 90 },
        { taskId: "low", winner: "B", confidence: 20 },
      ],
    });
  });

  it("requires the configured suite margin threshold", () => {
    expect(aggregateSuite([
      taskVerdict("a", "A", 90),
      taskVerdict("b", "A", 80),
      taskVerdict("c", "B", 90),
    ], { ...policy, marginThreshold: 2 })).toMatchObject({
      winsA: 2,
      winsB: 1,
      winner: "tie",
    });
  });

  it("creates deterministic missing-data verdicts without calling the judge", async () => {
    const judgeCalls: string[] = [];
    const verdict = await judgeSuite({
      runA: readRun({ taskId: "task-1", status: "ok", recordPath: "a.json" }),
      runB: readRun({ taskId: "task-1", status: "missing", recordPath: "b.json" }),
      tasks: [{ task_id: "task-1", goal: "Return Paris", args: {} }],
      policy,
      judgePair: async () => {
        judgeCalls.push("called");
        return taskVerdict("task-1", "tie", 0);
      },
    });

    expect(judgeCalls).toEqual([]);
    expect(verdict).toMatchObject({
      winsA: 1,
      winsB: 0,
      ties: 0,
      winner: "A",
      perTask: [{
        taskId: "task-1",
        winner: "A",
        inputs: [{ status: "ok" }, { status: "missing" }],
      }],
    });
  });

  it("ties tasks when both sides are missing or failed", async () => {
    const verdict = await judgeSuite({
      runA: readRun({ taskId: "task-1", status: "failed", errorMessage: "boom" }),
      runB: readRun({ taskId: "task-1", status: "missing" }),
      tasks: [{ task_id: "task-1", goal: "Return Paris", args: {} }],
      policy,
      judgePair: async () => taskVerdict("task-1", "A", 100),
    });

    expect(verdict).toMatchObject({
      winsA: 0,
      winsB: 0,
      ties: 1,
      winner: "tie",
      perTask: [{
        taskId: "task-1",
        winner: "tie",
        inputs: [{ status: "failed", errorMessage: "boom" }, { status: "missing" }],
      }],
    });
  });
});

function taskVerdict(taskId: string, winner: "A" | "B" | "tie", confidence: number): TaskVerdict {
  return {
    taskId,
    goal: "Return Paris",
    inputs: [{ path: `${taskId}-a.json`, status: "ok" }, { path: `${taskId}-b.json`, status: "ok" }],
    winner,
    confidence,
    reasoning: `${winner} wins`,
    samples: [{ winner, confidence, reasoning: `${winner} wins`, order: "AB" }],
    generatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function readRun(task: {
  taskId: string;
  status: "ok" | "missing" | "failed";
  recordPath?: string;
  errorMessage?: string;
}): ReadEvalRunResult {
  return {
    runDir: "/run",
    tasksById: {
      [task.taskId]: {
        taskId: task.taskId,
        task: { task_id: task.taskId, goal: "Return Paris", args: {} },
        ...(task.recordPath ? { recordPath: task.recordPath } : {}),
        status: task.status,
        ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
      },
    },
  };
}
