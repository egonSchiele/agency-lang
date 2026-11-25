import { describe, expect, it } from "vitest";

import { formatImportSummary, hasErrors } from "./formatImport.js";
import type { ImportResult } from "./importHarbor.js";
import { planHarborImport } from "./planImport.js";
import type { HarborTrial } from "./readTrials.js";

function trial(testId: string, overrides: Partial<HarborTrial> = {}): HarborTrial {
  return {
    jobName: "job",
    trialName: `${testId}__x`,
    testId,
    benchmark: "swe-bench-verified",
    startedAt: "2026-11-13T10:00:00Z",
    rewards: { reward: 1 },
    exception: null,
    statelogPath: "/t/agent/statelog.jsonl",
    agentName: null,
    reported: null,
    ...overrides,
  };
}

function resultOf(trials: HarborTrial[], extra: Partial<ImportResult> = {}): ImportResult {
  const plan = planHarborImport({ trials, batch: "k" });
  return {
    plan,
    outcomes: plan.runs.map((run) => ({ status: "imported", dir: `/out/k/${run.relativeDir}` })),
    problems: [],
    uploadPath: "/out/k",
    ...extra,
  };
}

describe("formatImportSummary", () => {
  it("prints failures, problems, counts, uneven trials, unknown exceptions and the upload command", () => {
    const voidTrial = trial("C", {
      rewards: null,
      exception: { type: "SomethingNew", message: "?" },
    });
    const trials = [trial("A"), trial("A"), trial("B"), voidTrial];
    const result = resultOf(trials, {
      outcomes: [
        { status: "imported", dir: "/out/k/A/1" },
        { status: "present", dir: "/out/k/A/2" },
        { status: "failed", path: "/out/k/B/1", error: "holds 2 traces" },
        { status: "imported", dir: "/out/k/C/1" },
      ],
      problems: [{ path: "/jobs/job/D__y", reason: "no result.json" }],
    });
    expect(formatImportSummary(result)).toEqual([
      "failed: /out/k/B/1: holds 2 traces",
      "problem: /jobs/job/D__y: no result.json",
      "2 imported · 1 present · 0 scored · 1 void · 1 failed",
      "uneven trials: 2 trials: 1 test; 1 trial: 2 tests (B, C)",
      "unknown exception types (counted as void): SomethingNew",
      "upload with: agency eval upload /out/k",
    ]);
  });

  it("prints only counts and the upload command for a clean, even import", () => {
    expect(formatImportSummary(resultOf([trial("A"), trial("B")]))).toEqual([
      "2 imported · 0 present · 0 scored · 0 void · 0 failed",
      "upload with: agency eval upload /out/k",
    ]);
  });

  it("lists at most 10 tests per group", () => {
    const many = Array.from({ length: 12 }, (_, index) => trial(`t${index}`));
    const line = formatImportSummary(resultOf([trial("A"), trial("A"), ...many])).find((each) =>
      each.startsWith("uneven"),
    );
    expect(line).toBe(
      "uneven trials: 2 trials: 1 test; 1 trial: 12 tests (t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, …)",
    );
  });
});

describe("hasErrors", () => {
  it("is true for a problem alone, and false for a clean import", () => {
    const clean = resultOf([trial("A")]);
    expect(hasErrors(clean)).toBe(false);
    expect(hasErrors({ ...clean, problems: [{ path: "/x", reason: "no result.json" }] })).toBe(
      true,
    );
    expect(
      hasErrors({ ...clean, outcomes: [{ status: "failed", path: "/x", error: "boom" }] }),
    ).toBe(true);
  });
});
