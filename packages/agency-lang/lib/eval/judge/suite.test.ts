import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";

import {
  aggregateSuite,
  judgeSuite,
  mapWinnerToOriginal,
  orderForSample,
  reduceSamples,
} from "./suite.js";
import type { JudgeAggregationPolicy, InputVerdict } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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
      inputs: [
        { path: "a.json", status: "ok" },
        { path: "b.json", status: "ok" },
      ],
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
    expect(
      aggregateSuite(
        [inputVerdict("a", "A", 90), inputVerdict("b", "B", 90), inputVerdict("low", "B", 20)],
        policy,
      ),
    ).toMatchObject({
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
    expect(
      aggregateSuite(
        [inputVerdict("a", "A", 90), inputVerdict("b", "A", 80), inputVerdict("c", "B", 90)],
        { ...policy, marginThreshold: 2 },
      ),
    ).toMatchObject({
      winsA: 2,
      winsB: 1,
      winner: "tie",
    });
  });

  it("creates deterministic missing-data verdicts without calling the judge", async () => {
    const judgeCalls: string[] = [];
    const verdict = await judgeSuite({
      runA: writeRunDir({ inputId: "task-1", status: "ok" }),
      runB: writeRunDir({ inputId: "task-1", status: "missing" }),
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
      perInput: [
        {
          inputId: "task-1",
          winner: "A",
          inputs: [{ status: "ok" }, { status: "missing" }],
        },
      ],
    });
  });

  it("ties inputs when both sides are missing or failed", async () => {
    const verdict = await judgeSuite({
      runA: writeRunDir({ inputId: "task-1", status: "failed", errorMessage: "boom" }),
      runB: writeRunDir({ inputId: "task-1", status: "missing" }),
      policy,
      judgePair: async () => inputVerdict("task-1", "A", 100),
    });

    expect(verdict).toMatchObject({
      winsA: 0,
      winsB: 0,
      ties: 1,
      winner: "tie",
      perInput: [
        {
          inputId: "task-1",
          winner: "tie",
          inputs: [{ status: "failed", errorMessage: "boom" }, { status: "missing" }],
        },
      ],
    });
  });
});

function inputVerdict(
  inputId: string,
  winner: "A" | "B" | "tie",
  confidence: number,
): InputVerdict {
  return {
    inputId,
    goal: "Return Paris",
    inputs: [
      { path: `${inputId}-a.json`, status: "ok" },
      { path: `${inputId}-b.json`, status: "ok" },
    ],
    winner,
    confidence,
    reasoning: `${winner} wins`,
    samples: [{ winner, confidence, reasoning: `${winner} wins`, order: "AB" }],
    generatedAt: "2026-06-11T00:00:00.000Z",
  };
}

/** A one-test run directory on disk in the given state — judgeSuite reads
 *  directories only, so the fixture is files, not a loaded shape. `missing`
 *  is a directory that has no such test at all. */
function writeRunDir(args: {
  inputId: string;
  status: "ok" | "missing" | "failed";
  errorMessage?: string;
}): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-suite-"));
  dirs.push(runDir);
  if (args.status === "missing") {
    return writeRunDirectory([], runDir);
  }
  return writeRunDirectory(
    [
      {
        test: { id: args.inputId, goal: "Return Paris", input: "t" },
        output: args.status === "ok" ? "x" : undefined,
        ended: args.status === "ok" ? "ok" : "error",
        errorMessage: args.errorMessage,
      },
    ],
    runDir,
  );
}
