import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { writeRunDirectory, type FakeRun } from "@/eval/runDirectoryFixture.js";
import type { Test } from "@/eval/runTypes.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";

import { AgencyRunner } from "./agencyRunner.js";
import { grader } from "./functionGrader.js";
import { gradeRun, type GradingContext } from "./gradeRun.js";
import { snapshotHarness } from "./harnessSnapshot.js";

const capital: Test = { id: "a", goal: "name the capital", input: "t", expected: "New Delhi" };

function makeRun(run: Omit<FakeRun, "test"> & { test?: Test }): string {
  return writeRunDirectory({ test: capital, workdirFiles: { "note.txt": "x" }, ...run });
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
  it("carries the run's notes.md alongside its grades", async () => {
    const runDir = makeRun({ output: "New Delhi" });
    fs.writeFileSync(runDirPaths(runDir).notes, "too slow\n");
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

  it("a suite where every test died before its first event does not pass gates vacuously", async () => {
    const runDir = writeRunDirectory({ test: capital, wroteStatelog: false, ended: "timeout" });
    // Still a run directory by the walk rule: an empty statelog, as the harness writes.
    expect(fs.readFileSync(path.join(runDir, "statelog.jsonl"), "utf8")).toBe("");
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

  it("a default goal fills in for tests that recorded none, and never overrides a test's own", async () => {
    const withGoal = makeRun({ output: "hello" });
    const withoutGoal = makeRun({ output: "hello", test: { id: "b", input: "t" } });
    const seen: unknown[] = [];
    const spy = grader(
      ({ test }) => {
        seen.push(test.goal);
        return 1;
      },
      { name: "spy" },
    );

    await gradeRun(withGoal, { ...ctx([spy]), defaultGoal: "be nice" });
    await gradeRun(withoutGoal, { ...ctx([spy]), defaultGoal: "be nice" });
    await gradeRun(withoutGoal, ctx([spy]));

    expect(seen).toEqual(["name the capital", "be nice", undefined]);
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

describe("harness graders from the run row", () => {
  function harnessFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-fixture-"));
    fs.writeFileSync(path.join(dir, "h.agency"), "export node t(): number {\n  return 1\n}\n");
    fs.writeFileSync(
      path.join(dir, "h.test.json"),
      JSON.stringify({
        tests: [{ nodeName: "t", expectedOutput: "1", evaluationCriteria: [{ type: "exact" }] }],
      }),
    );
    return snapshotHarness(
      [
        {
          name: "h",
          visibility: "holdout",
          agencyFile: path.join(dir, "h.agency"),
          testJsonFile: path.join(dir, "h.test.json"),
        },
      ],
      3,
    );
  }

  it("builds one AgencyTestGrader per record, bound to the stored files, under --graders and --goal alike", async () => {
    const harness = harnessFixture();
    const runDir = makeRun({ output: "x", harness });
    const spy = grader(() => 1, { name: "spy" });
    // The spy stands in for a --graders override; the harness grader must still be there.
    const card = await gradeRun(runDir, { ...ctx([spy]), defaultGoal: "g" });
    const names = card.perInput[0].grades.map((g) => g.grader.name());
    expect(names).toContain("spy");
    expect(names).toContain("h");
    const harnessGrade = card.perInput[0].grades.find((g) => g.grader.name() === "h");
    expect(harnessGrade?.grader.annotator().id).toBe(`agency-tests/h@${harness.records[0].sha256}`);
  });

  it("a test with Agency tests gets no fallback grader: those tests are its graders", async () => {
    const harness = harnessFixture();
    const runDir = makeRun({ output: "x", harness, test: { id: "a", input: "t" } });
    // The spy stands in for the suite fallback (a config module or the goal
    // judge). With no goal on the test, the goal judge would refuse to run.
    const fallback = grader(() => 1, { name: "fallback" });
    const card = await gradeRun(runDir, {
      ...ctx([fallback]),
      suiteGraders: { mode: "fallback", graders: [fallback] },
    });
    const names = card.perInput[0].grades.map((g) => g.grader.name());
    expect(names).toEqual(["h"]);
  });

  it("a record whose stored file is missing fails grading by name", async () => {
    const harness = harnessFixture();
    const runDir = makeRun({ output: "x", harness });
    fs.rmSync(path.join(runDirPaths(runDir).gradersDir, harness.records[0].json));
    await expect(gradeRun(runDir, ctx([]))).rejects.toThrow(
      /Harness snapshot not found.*recorded for h/,
    );
  });
});
