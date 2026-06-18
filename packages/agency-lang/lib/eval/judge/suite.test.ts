import { describe, expect, it } from "vitest";

import {
  aggregateSuite,
  judgeSuite,
  mapWinnerToOriginal,
  orderForSample,
  reduceSamples,
} from "./suite.js";
import type { JudgeAggregationPolicy, InputVerdict } from "./types.js";
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
      inputId: "task-1",
      goal: "Return Paris",
      inputs: [{ path: "a.json", status: "ok" }, { path: "b.json", status: "ok" }],
      samples: [
        { winner: "A", confidence: 80, reasoning: "first A", order: "AB" },
        { winner: "A", confidence: 70, reasoning: "swapped A", order: "BA" },
      ],
    });

    expect(verdict).toMatchObject({
      inputId: "task-1",
      goal: "Return Paris",
      winner: "tie",
      confidence: 75,
    });
    expect(verdict.samples.map((sample) => sample.winner)).toEqual(["A", "B"]);
  });

  it("aggregates low-confidence input verdicts as ties", () => {
    expect(aggregateSuite([
      inputVerdict("a", "A", 90),
      inputVerdict("b", "B", 90),
      inputVerdict("low", "B", 20),
    ], policy)).toMatchObject({
      verdictVersion: 2,
      winsA: 1,
      winsB: 1,
      ties: 1,
      winner: "tie",
      perInput: [
        { inputId: "a", winner: "A", confidence: 90 },
        { inputId: "b", winner: "B", confidence: 90 },
        { inputId: "low", winner: "B", confidence: 20 },
      ],
    });
  });

  it("requires the configured suite margin threshold", () => {
    expect(aggregateSuite([
      inputVerdict("a", "A", 90),
      inputVerdict("b", "A", 80),
      inputVerdict("c", "B", 90),
    ], { ...policy, marginThreshold: 2 })).toMatchObject({
      winsA: 2,
      winsB: 1,
      winner: "tie",
    });
  });

  it("creates deterministic missing-data verdicts without calling the judge", async () => {
    const judgeCalls: string[] = [];
    const verdict = await judgeSuite({
      runA: readRun({ inputId: "task-1", status: "ok", recordPath: "a.json" }),
      runB: readRun({ inputId: "task-1", status: "missing", recordPath: "b.json" }),
      inputs: [{ id: "task-1", goal: "Return Paris", args: {} }],
      policy,
      judgePair: async () => {
        judgeCalls.push("called");
        return inputVerdict("task-1", "tie", 0);
      },
    });

    expect(judgeCalls).toEqual([]);
    expect(verdict).toMatchObject({
      winsA: 1,
      winsB: 0,
      ties: 0,
      winner: "A",
      perInput: [{
        inputId: "task-1",
        winner: "A",
        inputs: [{ status: "ok" }, { status: "missing" }],
      }],
    });
  });

  it("ties inputs when both sides are missing or failed", async () => {
    const verdict = await judgeSuite({
      runA: readRun({ inputId: "task-1", status: "failed", errorMessage: "boom" }),
      runB: readRun({ inputId: "task-1", status: "missing" }),
      inputs: [{ id: "task-1", goal: "Return Paris", args: {} }],
      policy,
      judgePair: async () => inputVerdict("task-1", "A", 100),
    });

    expect(verdict).toMatchObject({
      winsA: 0,
      winsB: 0,
      ties: 1,
      winner: "tie",
      perInput: [{
        inputId: "task-1",
        winner: "tie",
        inputs: [{ status: "failed", errorMessage: "boom" }, { status: "missing" }],
      }],
    });
  });
});

function inputVerdict(inputId: string, winner: "A" | "B" | "tie", confidence: number): InputVerdict {
  return {
    inputId,
    goal: "Return Paris",
    inputs: [{ path: `${inputId}-a.json`, status: "ok" }, { path: `${inputId}-b.json`, status: "ok" }],
    winner,
    confidence,
    reasoning: `${winner} wins`,
    samples: [{ winner, confidence, reasoning: `${winner} wins`, order: "AB" }],
    generatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function readRun(input: {
  inputId: string;
  status: "ok" | "missing" | "failed";
  recordPath?: string;
  errorMessage?: string;
}): ReadEvalRunResult {
  return {
    runDir: "/run",
    inputsById: {
      [input.inputId]: {
        inputId: input.inputId,
        input: { id: input.inputId, goal: "Return Paris", args: {} },
        ...(input.recordPath ? { recordPath: input.recordPath } : {}),
        status: input.status,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
    },
  };
}
