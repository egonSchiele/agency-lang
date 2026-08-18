import * as fs from "fs";

import { describe, expect, it } from "vitest";

import { writeRunDirectory, type FakeRun } from "@/eval/runDirectoryFixture.js";
import type { Test } from "@/eval/runTypes.js";
import { recordNote } from "@/runDirectory/mutations.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { AgencyRunner } from "./agencyRunner.js";
import { grader } from "./functionGrader.js";
import { gradeRun, type GradingContext } from "./gradeRun.js";

const capital: Test = { id: "a", goal: "name the capital", input: "t", expected: "New Delhi" };

function makeRun(run: Omit<FakeRun, "test"> & { test?: Test }): string {
  return writeRunDirectory([{ test: capital, workdirFiles: { "note.txt": "x" }, ...run }]);
}

function ctx(graders: ReturnType<typeof grader>[]): GradingContext {
  return {
    suiteGraders: { mode: "override", graders },
    runAgency: new AgencyRunner({}),
    config: {},
  };
}

describe("grading one trace (through gradeRun on a directory of one)", () => {
  it("gives a grader the output, workdir, and computed record", async () => {
    const runDir = makeRun({ output: "New Delhi", costUsd: 0.01 });
    let seen: { output?: unknown; workdir?: string; record?: any } = {};
    const spy = grader(
      (context) => {
        seen = context;
        return 1;
      },
      { name: "spy" },
    );

    const card = await gradeRun(runDir, ctx([spy]));

    expect(seen.output).toBe("New Delhi");
    expect(fs.existsSync(seen.workdir as string)).toBe(true);
    expect(seen.record.metrics.costUsdTotal).toBe(0.01);
    expect(card.perInput[0].gatesPassed).toBe(true);
  });

  it("runs mustPass gates before advisory graders and short-circuits on failure", async () => {
    const runDir = makeRun({ output: "x" });
    const order: string[] = [];
    const gate = grader(
      () => {
        order.push("gate");
        return false;
      },
      { name: "gate", mustPass: true },
    );
    const advisory = grader(
      () => {
        order.push("advisory");
        return 1;
      },
      { name: "advisory" },
    );

    const card = await gradeRun(runDir, ctx([advisory, gate]));

    expect(order).toEqual(["gate"]);
    expect(card.perInput[0].gatesPassed).toBe(false);
  });
});

describe("gradeRun", () => {
  it("carries the notes people left on a trace alongside its grades", async () => {
    const runDir = makeRun({ output: "New Delhi" });
    recordNote({
      dir: runDir,
      traceId: "trace-1",
      annotator: { kind: "human", id: "adit" },
      text: "too slow",
    });
    const card = await gradeRun(runDir, ctx([grader(() => 1, { name: "g" })]));
    expect(card.perInput[0].humanFeedback).toEqual({
      notes: ["too slow"],
      checked: [],
      unchecked: [],
    });
  });

  it("scores a run the harness marked as errored 0, gate-failed, without showing it to graders", async () => {
    const runDir = makeRun({ output: "plausible answer", ended: "error", errorMessage: "boom" });
    let graderRan = false;
    const spy = grader(
      () => {
        graderRan = true;
        return 1;
      },
      { name: "spy" },
    );

    const card = await gradeRun(runDir, ctx([spy]));

    expect(graderRan).toBe(false);
    expect(card.objective()).toBe(0);
    expect(card.gatesPassed()).toBe(false);
    expect(card.perInput[0].ungradedReason).toMatch(/ended with error: boom/);
  });

  it("scores a run killed at the wall clock 0 — the harness verdict beats the trace's own ending", async () => {
    // The trace itself ended cleanly (agentEnd with a result), but the harness
    // says it was killed; the harness knows more.
    const runDir = makeRun({ output: "done", ended: "timeout" });
    const card = await gradeRun(runDir, ctx([grader(() => 1, { name: "never-runs" })]));
    expect(card.perInput[0].ungradedReason).toMatch(/timeout/);
  });

  it("a test that died before its first event still counts: scored 0 beside its successful neighbour", async () => {
    const runDir = writeRunDirectory([
      { test: { ...capital, id: "ok" }, output: "New Delhi" },
      {
        test: { ...capital, id: "never-started" },
        wroteStatelog: false,
        ended: "error",
        errorMessage: "compile failed",
      },
    ]);
    const card = await gradeRun(runDir, ctx([grader(() => 1, { name: "one" })]));
    expect(card.perInput.map((entry) => entry.test.id).sort()).toEqual(["never-started", "ok"]);
    expect(card.objective()).toBe(0.5);
    expect(card.gatesPassed()).toBe(false);
    const dead = card.perInput.find((entry) => entry.test.id === "never-started");
    expect(dead?.ungradedReason).toMatch(/no trace.*error: compile failed/);
  });

  it("a suite where every test died before its first event does not pass gates vacuously", async () => {
    const runDir = writeRunDirectory([{ test: capital, wroteStatelog: false, ended: "timeout" }]);
    const card = await gradeRun(runDir, ctx([grader(() => 1, { name: "one" })]));
    expect(card.perInput).toHaveLength(1);
    expect(card.gatesPassed()).toBe(false);
    expect(card.objective()).toBe(0);
  });

  it("a trace with no output still grades, with output null — the deliverable may be the filesystem", async () => {
    // Command agents (agency CLI under --agent-cmd) emit no output event;
    // terminal-bench-style graders read the workdir, not the reply. A real
    // agent once PASSED a task and was scored ungraded over this.
    const runDir = makeRun({});
    let sawOutput: unknown = "unset";
    const disk = grader(
      ({ output }) => {
        sawOutput = output;
        return 1;
      },
      { name: "disk-grader" },
    );

    const card = await gradeRun(runDir, ctx([disk]));

    expect(card.perInput[0].ungradedReason).toBeUndefined();
    expect(card.objective()).toBe(1);
    expect(sawOutput).toBeNull();
  });

  it("reads the test from the run row, so goal and expected survive", async () => {
    const runDir = makeRun({ output: "hello" });
    let seenGoal: unknown = "not-read";
    let seenExpected: unknown = "not-read";
    const spy = grader(
      ({ test }) => {
        seenGoal = test.goal;
        seenExpected = test.expected;
        return 1;
      },
      { name: "spy" },
    );

    await gradeRun(runDir, ctx([spy]));

    expect(seenGoal).toBe("name the capital");
    expect(seenExpected).toBe("New Delhi");
  });

  it("grades an ad-hoc trace with no run row by its own ending, as a test named by its trace id", async () => {
    const runDir = makeRun({ output: "hello", traceId: "adhoc" });
    // Strip the run row: the directory is now just a statelog.
    const { annotations } = { annotations: `${runDir}/annotations.jsonl` };
    fs.rmSync(annotations);
    expect(readRunDirectory(runDir, { reportWarning: () => {} }).annotationRows).toEqual([]);
    let seenId: string | undefined;
    const spy = grader(
      ({ test }) => {
        seenId = test.id;
        return 1;
      },
      { name: "spy" },
    );
    const card = await gradeRun(runDir, ctx([spy]));
    expect(seenId).toBe("adhoc");
    expect(card.objective()).toBe(1);
  });
});
