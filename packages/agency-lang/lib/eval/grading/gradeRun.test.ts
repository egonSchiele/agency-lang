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
import { snapshotGraderFiles } from "./graderFilesSnapshot.js";

const capital: Test = { id: "a", goal: "name the capital", input: "t", expected: "New Delhi" };

function makeRun(run: Omit<FakeRun, "test"> & { test?: Test }): string {
  return writeRunDirectory({ test: capital, workdirFiles: { "note.txt": "x" }, ...run });
}

function ctx(graders: ReturnType<typeof grader>[]): GradingContext {
  return {
    graders: { kind: "override", graders },
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

  it("a grader that throws scores 0 with the error as feedback, and the rest still run", async () => {
    const runDir = makeRun({ output: "x" });
    const broken = grader(
      () => {
        throw new Error("structured return failed schema validation");
      },
      { name: "broken" },
    );
    const fine = grader(() => 1, { name: "fine" });

    const card = await gradeRun(runDir, ctx([broken, fine]));

    const grades = card.perInput[0].grades;
    expect(grades.map((g) => g.grader.name())).toEqual(["broken", "fine"]);
    expect(grades[0].grade.score).toEqual({ kind: "binary", pass: false });
    expect(grades[0].grade.feedback).toContain("structured return failed schema validation");
    expect(grades[1].grade.score).toEqual({ kind: "scalar", value: 1 });
  });

  it("a must-pass grader that throws fails its gate", async () => {
    const runDir = makeRun({ output: "x" });
    const brokenGate = grader(
      () => {
        throw new Error("judge unavailable");
      },
      { name: "broken-gate", mustPass: true },
    );
    const advisory = grader(() => 1, { name: "advisory" });

    const card = await gradeRun(runDir, ctx([brokenGate, advisory]));

    expect(card.perInput[0].gatesPassed).toBe(false);
    expect(card.perInput[0].grades.map((g) => g.grader.name())).toEqual(["broken-gate"]);
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

describe("grader files from the run row", () => {
  function graderFilesFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grader-files-fixture-"));
    fs.writeFileSync(path.join(dir, "notes.md"), "lead with the why");
    return { dir, snapshot: snapshotGraderFiles(dir) };
  }

  it("hands graders the stored copy under an override, and the suite's own directory under --suite", async () => {
    const { dir, snapshot } = graderFilesFixture();
    const runDir = makeRun({ output: "x", graderFiles: snapshot });
    const seen: string[] = [];
    const spy = grader(
      ({ graderFiles }) => {
        seen.push(graderFiles);
        return 1;
      },
      { name: "spy" },
    );

    await gradeRun(runDir, ctx([spy]));
    expect(seen[0]).toBe(path.join(runDirPaths(runDir).gradersDir, snapshot.dirName));
    expect(fs.readFileSync(path.join(seen[0], "notes.md"), "utf8")).toBe("lead with the why");

    // Under --suite the suite test's own directory is handed over, not the
    // stored copy. A spy in memory cannot be a suite module, so this half
    // goes through a module file.
    const live = path.join(dir, "live");
    fs.mkdirSync(live);
    const modulePath = path.join(dir, "graders.ts");
    fs.writeFileSync(
      modulePath,
      'import { grader } from "agency-lang/eval";\n' +
        "export default [grader(({ graderFiles }) => graderFiles.endsWith('/live') ? 1 : 0, { name: 'live' })];",
    );
    const card = await gradeRun(runDir, {
      ...ctx([]),
      graders: { kind: "suite", tests: [{ ...capital, graders: modulePath, graderFiles: live }] },
    });
    expect(card.perInput[0].grades.map((g) => [g.grader.name(), g.grade.score])).toEqual([
      ["live", { kind: "scalar", value: 1 }],
    ]);
  });

  it("a test with no grader files gives the grader an empty path", async () => {
    const runDir = makeRun({ output: "x" });
    let seen: string | undefined;
    const spy = grader(
      ({ graderFiles }) => {
        seen = graderFiles;
        return 1;
      },
      { name: "spy" },
    );
    await gradeRun(runDir, ctx([spy]));
    expect(seen).toBe("");
  });

  it("a recorded copy that is missing from the run directory fails grading by test", async () => {
    const { snapshot } = graderFilesFixture();
    const runDir = makeRun({ output: "x", graderFiles: snapshot });
    fs.rmSync(path.join(runDirPaths(runDir).gradersDir, snapshot.dirName), { recursive: true });
    await expect(gradeRun(runDir, ctx([]))).rejects.toThrow(
      /Grader files snapshot not found.*recorded for test a/,
    );
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

  it("builds one AgencyTestGrader per record, bound to the stored files, under an override and --goal alike", async () => {
    const harness = harnessFixture();
    const runDir = makeRun({ output: "x", harness });
    const spy = grader(() => 1, { name: "spy" });
    // The spy is an override set (the optimizer's); the harness grader must still be there.
    const card = await gradeRun(runDir, { ...ctx([spy]), defaultGoal: "g" });
    const names = card.perInput[0].grades.map((g) => g.grader.name());
    expect(names).toContain("spy");
    expect(names).toContain("h");
    const harnessGrade = card.perInput[0].grades.find((g) => g.grader.name() === "h");
    expect(harnessGrade?.grader.annotator().id).toBe(`agency-tests/h@${harness.records[0].sha256}`);
  });

  it("a test with Agency tests gets no goal judge: those tests are its graders", async () => {
    const harness = harnessFixture();
    // No goal on the test: the goal judge would refuse to run if it were added.
    const runDir = makeRun({ output: "x", harness, test: { id: "a", input: "t" } });
    const card = await gradeRun(runDir, { ...ctx([]), graders: { kind: "snapshot" } });
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
