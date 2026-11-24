import { describe, expect, it } from "vitest";

import { endedOf, isVoid, planHarborImport, scoresOf } from "./planImport.js";
import type { HarborTrial } from "./readTrials.js";

function trial(overrides: Partial<HarborTrial> = {}): HarborTrial {
  return {
    jobName: "k1-agency-minimal",
    trialName: "astropy__astropy-12907__qk72YVE",
    testId: "astropy__astropy-12907",
    benchmark: "swe-bench-verified",
    startedAt: "2026-11-13T10:00:00Z",
    rewards: { reward: 1 },
    exception: null,
    statelogPath: "/jobs/k1/astropy__astropy-12907__qk72YVE/agent/statelog.jsonl",
    ...overrides,
  };
}

function failingWith(type: string): HarborTrial["exception"] {
  return { type, message: "it broke" };
}

describe("isVoid", () => {
  it("a trial with no trace is void, even with an agent-fault exception", () => {
    expect(
      isVoid(
        trial({
          statelogPath: null,
          rewards: null,
          exception: failingWith("NonZeroAgentExitCodeError"),
        }),
      ),
    ).toBe(true);
  });

  it("a trace with a reward is not void, even after a timeout", () => {
    expect(isVoid(trial({ exception: failingWith("AgentTimeoutError") }))).toBe(false);
  });

  it.each(["AgentTimeoutError", "NonZeroAgentExitCodeError"])(
    "a trace with no reward and %s is the agent's fault, not void",
    (type) => {
      expect(isVoid(trial({ rewards: null, exception: failingWith(type) }))).toBe(false);
    },
  );

  it.each([
    "DaytonaError",
    "CancelledError",
    "VerifierTimeoutError",
    "RewardFileNotFoundError",
    "SomethingNew",
  ])("a trace with no reward and %s is void", (type) => {
    expect(isVoid(trial({ rewards: null, exception: failingWith(type) }))).toBe(true);
  });
});

describe("scoresOf", () => {
  it("a reward of 1 or 0 is binary, anything else is scalar", () => {
    expect(scoresOf(trial({ rewards: { reward: 1 } }))).toEqual([
      { name: "reward", score: { kind: "binary", pass: true } },
    ]);
    expect(scoresOf(trial({ rewards: { reward: 0 } }))).toEqual([
      { name: "reward", score: { kind: "binary", pass: false } },
    ]);
    expect(scoresOf(trial({ rewards: { reward: 0.5 } }))).toEqual([
      { name: "reward", score: { kind: "scalar", value: 0.5 } },
    ]);
  });

  it("each reward key is its own score", () => {
    expect(scoresOf(trial({ rewards: { a: 1, b: 0 } }))).toEqual([
      { name: "a", score: { kind: "binary", pass: true } },
      { name: "b", score: { kind: "binary", pass: false } },
    ]);
  });

  it("an agent-fault trial with no reward scores one binary fail", () => {
    expect(scoresOf(trial({ rewards: null, exception: failingWith("AgentTimeoutError") }))).toEqual(
      [{ name: "reward", score: { kind: "binary", pass: false } }],
    );
  });

  it("a void trial has no scores", () => {
    expect(scoresOf(trial({ rewards: null, exception: failingWith("DaytonaError") }))).toEqual([]);
  });
});

describe("endedOf", () => {
  it("names how the trial ended", () => {
    expect(endedOf(trial({ rewards: null, exception: failingWith("DaytonaError") }))).toBe("void");
    expect(endedOf(trial())).toBe("ok");
    expect(endedOf(trial({ exception: failingWith("AgentTimeoutError") }))).toBe("timeout");
    expect(endedOf(trial({ exception: failingWith("CancelledError") }))).toBe("killed");
    expect(endedOf(trial({ exception: failingWith("DaytonaError") }))).toBe("error");
  });
});

describe("planHarborImport", () => {
  const a1 = trial({ jobName: "job1", trialName: "A__1", testId: "A" });
  const b1 = trial({ jobName: "job1", trialName: "B__1", testId: "B" });
  const a2 = trial({ jobName: "job2", trialName: "A__2", testId: "A" });

  it("numbers each test's trials in input order", () => {
    const plan = planHarborImport({ trials: [a1, b1, a2], batch: "k" });
    expect(plan.runs.map((run) => run.relativeDir)).toEqual(["A/1", "B/1", "A/2"]);
    expect(plan.trialCounts).toEqual({ 2: ["A"], 1: ["B"] });
  });

  it("builds the whole run row", () => {
    const plan = planHarborImport({
      trials: [trial({ exception: failingWith("AgentTimeoutError") })],
      batch: "k-agency-minimal",
      reasoning: "high",
    });
    expect(plan.batch).toBe("k-agency-minimal");
    expect(plan.runs[0].payload).toEqual({
      kind: "run",
      test: { id: "astropy__astropy-12907" },
      suite: null,
      ended: "timeout",
      error: "AgentTimeoutError: it broke",
      flags: { harborJob: "k1-agency-minimal", harborTrial: "astropy__astropy-12907__qk72YVE" },
      batch: "k-agency-minimal",
      trial: 1,
      benchmark: "swe-bench-verified",
      reasoning: "high",
    });
  });

  it("leaves reasoning and error out when there are none", () => {
    const [run] = planHarborImport({ trials: [trial()], batch: "k" }).runs;
    expect(run.payload).not.toHaveProperty("reasoning");
    expect(run.payload).not.toHaveProperty("error");
  });

  it("gives a trial with no trace a stable silent trace id", () => {
    const silent = trial({ statelogPath: null, rewards: null });
    const first = planHarborImport({ trials: [silent], batch: "k" }).runs[0].silentTraceId;
    const again = planHarborImport({ trials: [silent], batch: "k" }).runs[0].silentTraceId;
    const other = planHarborImport({
      trials: [{ ...silent, trialName: "other" }],
      batch: "k",
    }).runs[0].silentTraceId;
    expect(first).toMatch(/^harbor-[0-9a-f]{24}$/);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(planHarborImport({ trials: [trial()], batch: "k" }).runs[0].silentTraceId).toBeNull();
  });

  it("names exception types it doesn't know, once each", () => {
    const unknown = trial({ rewards: null, exception: failingWith("SomethingNew") });
    const plan = planHarborImport({
      trials: [
        unknown,
        { ...unknown, trialName: "again" },
        trial({ rewards: null, exception: failingWith("DaytonaError") }),
        trial({ rewards: null, exception: failingWith("RuntimeError") }),
      ],
      batch: "k",
    });
    expect(plan.unknownExceptions).toEqual(["SomethingNew"]);
  });
});
