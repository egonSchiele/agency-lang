import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { writeRunDirectory, type FakeRun } from "@/eval/runDirectoryFixture.js";
import { getPackageRoot } from "@/importPaths.js";
import type { Test } from "@/eval/runTypes.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";

import { AgencyRunner } from "./agencyRunner.js";
import { grader } from "./functionGrader.js";
import { resetShellInterruptForTests } from "../shellCommand.js";
import { gradeRun, GradingInterrupted, type GradingContext } from "./gradeRun.js";
import { snapshotHarness } from "./harnessSnapshot.js";
import { snapshotGraderFiles } from "./graderFilesSnapshot.js";
import { buildGraders } from "../gradersJson/build.js";
import { snapshotGradersJson } from "../gradersJson/load.js";

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

  it("stops with an error naming the test when a must-pass scalar grader has no threshold", async () => {
    const runDir = makeRun({ output: "x", test: { ...capital, id: "t1" } });
    const judge = grader(() => 1, { name: "judge", mustPass: true });

    await expect(gradeRun(runDir, ctx([judge]))).rejects.toThrow(
      "t1: judge: must-pass grader returned a score but has no threshold",
    );
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
    // The module imports agency-lang, so its folder needs one, as a project
    // would have; vitest can't use the loader's fallback for a folder outside
    // any project (gradingModule.test.ts checks that in a real Node).
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.symlinkSync(getPackageRoot(), path.join(dir, "node_modules", "agency-lang"), "dir");
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

describe("graders.json from the run row and from the suite", () => {
  const JSON_GRADERS = JSON.stringify([
    { kind: "number", name: "cheap", measure: "costUsd", max: 0.05 },
  ]);

  it("grades a run whose row names a stored graders.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graders-json-"));
    const jsonPath = path.join(dir, "graders.json");
    fs.writeFileSync(jsonPath, JSON_GRADERS);
    const snapshot = { ...(await snapshotGradersJson(jsonPath)), origin: "test" as const };
    const runDir = makeRun({ output: "x", costUsd: 0.01, graders: snapshot });
    fs.rmSync(jsonPath);
    const card = await gradeRun(runDir, { ...ctx([]), graders: { kind: "snapshot" } });
    expect(card.perInput[0].grades.map((g) => [g.grader.name(), g.grade.score])).toEqual([
      ["cheap", { kind: "binary", pass: true }],
    ]);
  });

  it("grades a suite test whose graders path is a .json through the cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graders-json-"));
    const jsonPath = path.join(dir, "graders.json");
    fs.writeFileSync(jsonPath, JSON_GRADERS);
    const runDir = makeRun({ output: "x", costUsd: 0.5 });
    const card = await gradeRun(runDir, {
      ...ctx([]),
      graders: { kind: "suite", tests: [{ ...capital, graders: jsonPath }] },
    });
    expect(card.perInput[0].grades.map((g) => [g.grader.name(), g.grade.score])).toEqual([
      ["cheap", { kind: "binary", pass: false }],
    ]);
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

describe("graders that need the workdir to themselves", () => {
  const passes = (card: Awaited<ReturnType<typeof gradeRun>>): boolean[] =>
    card.perInput[0].grades.map((g) => g.grade.score.kind === "binary" && g.grade.score.pass);
  const workdirOf = (runDir: string): string => runDirPaths(runDir).workdirDir;

  it("never runs two of them at the same time", async () => {
    const runDir = makeRun({ output: "x" });
    const command = "test ! -e busy && touch busy && sleep 0.2 && rm busy";
    const card = await gradeRun(
      runDir,
      ctx(
        buildGraders([
          { kind: "command", name: "a", command },
          { kind: "command", name: "b", command },
          { kind: "command", name: "c", command },
        ]),
      ),
    );
    expect(passes(card)).toEqual([true, true, true]);
  });

  it("runs them in the order they were listed, and reports grades in that order", async () => {
    const runDir = makeRun({ output: "x" });
    const card = await gradeRun(
      runDir,
      ctx([
        ...buildGraders([{ kind: "command", name: "a", command: "echo a >> order.txt" }]),
        grader(() => true, { name: "plain" }),
        ...buildGraders([
          { kind: "command", name: "b", command: "echo b >> order.txt" },
          { kind: "command", name: "c", command: "echo c >> order.txt" },
        ]),
      ]),
    );
    expect(fs.readFileSync(path.join(workdirOf(runDir), "order.txt"), "utf8")).toBe("a\nb\nc\n");
    expect(card.perInput[0].grades.map((g) => g.grader.name())).toEqual(["a", "plain", "b", "c"]);
  });

  it(
    "gives the next one its turn after one fails or times out, with nothing of the old one left running",
    { timeout: 15_000 },
    async () => {
      const runDir = makeRun({ output: "x" });
      const card = await gradeRun(
        runDir,
        ctx(
          buildGraders([
            { kind: "command", name: "fails", command: "exit 1" },
            {
              kind: "command",
              name: "slow",
              command: "(sleep 2; touch late) & sleep 5",
              timeoutSec: 1,
            },
            { kind: "command", name: "after", command: "sleep 2.5; test ! -e late" },
          ]),
        ),
      );
      expect(passes(card)).toEqual([false, false, true]);
    },
  );

  it("starts a grader's time limit when its turn starts", { timeout: 10_000 }, async () => {
    const runDir = makeRun({ output: "x" });
    const card = await gradeRun(
      runDir,
      ctx(
        buildGraders([
          { kind: "command", name: "first", command: "sleep 1.5" },
          { kind: "command", name: "second", command: "sleep 1", timeoutSec: 2 },
        ]),
      ),
    );
    expect(passes(card)).toEqual([true, true]);
  });

  it("still runs the other graders together, beside the ones taking turns", async () => {
    const runDir = makeRun({ output: "x" });
    const wait = (): Promise<boolean> =>
      new Promise((resolve) => setTimeout(() => resolve(true), 300));
    const started = Date.now();
    await gradeRun(
      runDir,
      ctx([
        grader(wait, { name: "one" }),
        grader(wait, { name: "two" }),
        ...buildGraders([{ kind: "command", name: "c", command: "sleep 0.3" }]),
      ]),
    );
    expect(Date.now() - started).toBeLessThan(800);
  });
});

describe("grading after an interrupt", () => {
  it("throws, so no caller scores a run on commands that never ran", async () => {
    const runDir = makeRun({ output: "x" });
    const graders = buildGraders([{ kind: "command", name: "c", command: "sleep 5" }]);
    const grading = gradeRun(runDir, ctx(graders));
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.emit("SIGINT");
    await expect(grading).rejects.toThrow(GradingInterrupted);
    // Until the flag is cleared, grading keeps refusing instead of failing commands.
    await expect(gradeRun(runDir, ctx(graders))).rejects.toThrow(GradingInterrupted);
    resetShellInterruptForTests();
  });

  it("reports grades in listed order even when one grader object is listed twice", async () => {
    const runDir = makeRun({ output: "x" });
    const twice = grader(() => true, { name: "same" });
    const card = await gradeRun(
      runDir,
      ctx([twice, grader(() => false, { name: "other" }), twice]),
    );
    expect(card.perInput[0].grades.map((g) => g.grader.name())).toEqual(["same", "other", "same"]);
  });
});

describe("a workdir override", () => {
  it("gives graders the override in place of the run directory's stored copy", async () => {
    const runDir = makeRun({ output: "x", workdirFiles: { marker: "snapshot" } });
    const live = fs.mkdtempSync(path.join(os.tmpdir(), "live-workdir-"));
    fs.writeFileSync(path.join(live, "marker"), "live");
    const graders = buildGraders([
      { kind: "command", name: "is-live", command: "grep -q live marker" },
    ]);
    const passed = async (context: GradingContext): Promise<boolean> => {
      const { score } = (await gradeRun(runDir, context)).perInput[0].grades[0].grade;
      return score.kind === "binary" && score.pass;
    };
    expect(await passed({ ...ctx(graders), workdirOverride: live })).toBe(true);
    expect(await passed(ctx(graders))).toBe(false);
  });
});
