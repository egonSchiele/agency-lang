import * as fs from "fs";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { buildRunsListing } from "@/runDirectory/list.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { evalGrade, graderSourceFor, validateGradeTarget } from "./grade.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * A grading module. Written inside the package, not a temp dir, so its
 * `import "agency-lang/eval"` resolves against the workspace node_modules —
 * the same reason optimize.test.ts does this.
 */
function writeGraders(
  source: string,
  dir = fs.mkdtempSync(path.join(process.cwd(), ".test-grading-")),
): string {
  dirs.push(dir);
  const file = path.join(dir, "graders.ts");
  fs.writeFileSync(file, `import { grader } from "agency-lang/eval";\n${source}`);
  return file;
}

/** Scores by output length: "hello" → 0.5. */
function lengthGraders(): string {
  return writeGraders(
    `export default [grader(({ output }) => String(output).length / 10, { name: "len" })];`,
  );
}

/** A test that carries the length grader, the way a suite test does. */
function lenTest(id: string, extra: Record<string, unknown> = {}) {
  return { id, input: "t", graders: lengthGraders(), ...extra };
}

/** A finished run directory with one successful trace, as eval run writes it. */
function makeRunDir(output: string): string {
  const runDir = writeRunDirectory({ test: lenTest("a", { goal: "g" }), output });
  dirs.push(runDir);
  return runDir;
}

describe("evalGrade", () => {
  it("scores a run directory and records one complete grading pass", async () => {
    const runDir = makeRunDir("hello");

    const result = await evalGrade([runDir], { config: {} });

    expect(result.runs).toHaveLength(1);
    // Reported directories are canonical (realpath), the same path the pass was written to.
    expect(result.runs[0].dir).toBe(fs.realpathSync(runDir));
    expect(result.mean).toBeCloseTo(0.5);
    expect(result.runs[0].grading.graders).toEqual(["len"]);
    const snapshot = readRunDirectory(runDir, { reportWarning: () => {} });
    const scores = snapshot.annotationRows.filter((row) => row.kind === "score");
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      kind: "score",
      name: "len",
      passSize: 1,
      score: { kind: "scalar", value: 0.5 },
    });
    // The grader is identified by its module revision, so an edit in place is a
    // new annotator rather than an overwrite.
    expect(scores[0].annotator.kind).toBe("grader");
    expect(scores[0].annotator.id).toMatch(/graders\.ts@[0-9a-f]{64}$/);
    expect(Object.keys(snapshot.effectiveAnnotations["trace-1"].scores)).toHaveLength(1);
  });

  it("honors -o for a JSON summary; the pass is recorded either way", async () => {
    const runDir = makeRunDir("hello");
    const out = path.join(runDir, "custom.json");

    await evalGrade([runDir], { out, config: {} });

    expect(JSON.parse(fs.readFileSync(out, "utf8")).mean).toBeCloseTo(0.5);
    expect(fs.existsSync(path.join(runDir, "annotations.jsonl"))).toBe(true);
  });

  it("a second pass appends beside the first and becomes the effective one", async () => {
    const runDir = makeRunDir("hello"); // the run's own module both times: one annotator, two passes

    await evalGrade([runDir], { config: {} });
    await evalGrade([runDir], { config: {} });

    const snapshot = readRunDirectory(runDir, { reportWarning: () => {} });
    const scores = snapshot.annotationRows.filter((row) => row.kind === "score");
    expect(scores).toHaveLength(2);
    expect(new Set(scores.map((row) => (row.kind === "score" ? row.passId : ""))).size).toBe(2);
    const effective = snapshot.effectiveAnnotations["trace-1"].scores;
    expect(Object.values(effective)[0].id).toBe(scores[1].id);
  });

  it("grades every run directory in a group, one pass each, and reports the mean", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    writeRunDirectory({ test: lenTest("a"), output: "hello" }, path.join(group, "a"));
    writeRunDirectory({ test: lenTest("b"), output: "hello world" }, path.join(group, "b"));
    fs.writeFileSync(path.join(group, "notes.txt"), "not a run");

    const result = await evalGrade([group], { config: {} });

    expect(result.runs.map((run) => path.basename(run.dir))).toEqual(["a", "b"]);
    expect(result.mean).toBeCloseTo((0.5 + 1.1) / 2);
    for (const child of ["a", "b"]) {
      const snapshot = readRunDirectory(path.join(group, child), { reportWarning: () => {} });
      expect(snapshot.annotationRows.filter((row) => row.kind === "score")).toHaveLength(1);
    }
  });

  it("a group where one run fails a must-pass gate: that run scores 0, gatesPassed is false, the other keeps its score", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    const file = writeGraders(
      `export default [grader(({ output }) => output === "hello", { name: "gate", mustPass: true })];`,
    );
    writeRunDirectory(
      { test: { id: "a", input: "t", graders: file }, output: "hello" },
      path.join(group, "a"),
    );
    writeRunDirectory(
      { test: { id: "b", input: "t", graders: file }, output: "bye" },
      path.join(group, "b"),
    );

    const result = await evalGrade([group], { config: {} });

    expect(result.runs.map((run) => run.grading.objective)).toEqual([1, 0]);
    expect(result.gatesPassed).toBe(false);
    expect(result.mean).toBeCloseTo(0.5);
  });

  it("several paths: every run found is graded once, in walk order", async () => {
    const a = makeRunDir("hello");
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    writeRunDirectory({ test: lenTest("b"), output: "hello" }, path.join(group, "b"));

    const result = await evalGrade([a, group], { config: {} });

    expect(result.runs.map((run) => run.dir)).toEqual(
      [a, path.join(group, "b")].map((dir) => fs.realpathSync(dir)),
    );
    for (const dir of [a, path.join(group, "b")]) {
      const rows = readRunDirectory(dir, { reportWarning: () => {} }).annotationRows;
      expect(rows.filter((row) => row.kind === "score")).toHaveLength(1);
    }
  });

  it("a run named twice (through its group and directly) is graded once and counted once", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    const a = path.join(group, "a");
    writeRunDirectory({ test: lenTest("a"), output: "hello" }, a);
    writeRunDirectory({ test: lenTest("b"), output: "hello world" }, path.join(group, "b"));

    const result = await evalGrade([group, a], { config: {} });

    expect(result.runs.map((run) => path.basename(run.dir))).toEqual(["a", "b"]);
    expect(result.mean).toBeCloseTo((0.5 + 1.1) / 2);
    const rows = readRunDirectory(a, { reportWarning: () => {} }).annotationRows;
    expect(rows.filter((row) => row.kind === "score")).toHaveLength(1);
  });

  it("a symlink alias of a run directory is the same run: graded once", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    const a = path.join(group, "a");
    writeRunDirectory({ test: lenTest("a"), output: "hello" }, a);
    const alias = path.join(group, "alias");
    fs.symlinkSync(a, alias, "dir");

    const result = await evalGrade([a, alias], { config: {} });

    expect(result.runs).toHaveLength(1);
    const rows = readRunDirectory(a, { reportWarning: () => {} }).annotationRows;
    expect(rows.filter((row) => row.kind === "score")).toHaveLength(1);
  });

  it("an errored run scores zero in eval grade but has no score row, so the listing mean leaves it out", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    writeRunDirectory({ test: lenTest("a"), output: "hello" }, path.join(group, "a"));
    writeRunDirectory(
      { test: lenTest("b"), output: "hello", ended: "error" },
      path.join(group, "b"),
    );

    const result = await evalGrade([group], { config: {} });

    expect(result.mean).toBeCloseTo(0.5 / 2);
    const listing = buildRunsListing(
      [path.join(group, "a"), path.join(group, "b")].map((dir) =>
        readRunDirectory(dir, { reportWarning: () => {} }),
      ),
    );
    expect(listing.gradedCount).toBe(1);
    expect(listing.meanScore).toBeCloseTo(0.5);
  });

  it("a batch of trials: per-test statistics include a silent failed trial as zero", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-batch-"));
    dirs.push(group);
    const batch = path.basename(group);
    writeRunDirectory(
      { test: lenTest("a"), output: "hello", batch, trial: 1 },
      path.join(group, "a", "1"),
    );
    writeRunDirectory(
      { test: lenTest("a"), wroteStatelog: false, ended: "error", batch, trial: 2 },
      path.join(group, "a", "2"),
    );

    const result = await evalGrade([group], { config: {} });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({ batch, trials: 2, accuracy: 0.25 });
    expect(result.batches[0].tests).toEqual([
      expect.objectContaining({ testId: "a", trials: 2, mean: 0.25 }),
    ]);
  });

  it("two selected batches that reuse test and trial ids are reported separately, never merged", async () => {
    const groups = ["one", "two"].map((name) => {
      const group = fs.mkdtempSync(path.join(process.cwd(), `.test-batch-${name}-`));
      dirs.push(group);
      const batch = path.basename(group);
      for (const trial of [1, 2]) {
        writeRunDirectory(
          { test: lenTest("a"), output: "hello", batch, trial },
          path.join(group, "a", String(trial)),
        );
      }
      return group;
    });

    const result = await evalGrade(groups, { config: {} });

    expect(result.runs).toHaveLength(4);
    expect(result.batches.map((batch) => batch.batch)).toEqual(groups.map((g) => path.basename(g)));
    expect(result.batches.map((batch) => batch.trials)).toEqual([2, 2]);
  });

  it("a single-trial group reports no batch statistics", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    writeRunDirectory({ test: lenTest("a"), output: "hello" }, path.join(group, "a"));
    const result = await evalGrade([group], { config: {} });
    expect(result.batches).toEqual([]);
  });

  it("refuses a folder with no run directories, naming how to build one", () => {
    const folder = fs.mkdtempSync(path.join(process.cwd(), ".test-not-a-run-dir-"));
    dirs.push(folder);
    fs.writeFileSync(path.join(folder, "statelogs.jsonl"), "");
    expect(() => validateGradeTarget([folder], {})).toThrow(
      /not a run directory.*agency runs add/s,
    );
    expect(() => validateGradeTarget([makeRunDir("x")], {})).not.toThrow();
  });

  it("refuses --goal together with --suite", () => {
    expect(() => validateGradeTarget([makeRunDir("x")], { goal: "g", suite: "s" })).toThrow(
      /only one of --suite or --goal/,
    );
  });

  it("--suite grades with each test's current graders, matched by test id", async () => {
    // The run stored the length grader. The suite has the same test with a
    // different grader now: --suite uses the suite's.
    const runDir = makeRunDir("hello");
    const suite = fs.mkdtempSync(path.join(process.cwd(), ".test-suite-"));
    dirs.push(suite);
    fs.mkdirSync(path.join(suite, "a"));
    fs.writeFileSync(path.join(suite, "a", "test.json"), JSON.stringify({ input: "t" }));
    writeGraders(`export default [grader(() => 1, { name: "current" })];`, path.join(suite, "a"));

    const stored = await evalGrade([runDir], { config: {} });
    expect(stored.runs[0].grading.graders).toEqual(["len"]);
    expect(stored.mean).toBeCloseTo(0.5);

    const current = await evalGrade([runDir], { suite, config: {} });
    expect(current.runs[0].grading.graders).toEqual(["current"]);
    expect(current.mean).toBe(1);
  });

  it("--suite refuses a run whose test is not in the suite", async () => {
    const runDir = makeRunDir("hello");
    const suite = fs.mkdtempSync(path.join(process.cwd(), ".test-suite-"));
    dirs.push(suite);
    fs.mkdirSync(path.join(suite, "other"));
    fs.writeFileSync(path.join(suite, "other", "test.json"), JSON.stringify({ input: "t" }));
    writeGraders(`export default [grader(() => 1, { name: "g" })];`, path.join(suite, "other"));

    await expect(evalGrade([runDir], { suite, config: {} })).rejects.toThrow(
      /test "a" has no test with that id in the suite.*other/,
    );
  });

  it("graderSourceFor: the stored copy by default, the suite's tests under --suite", () => {
    expect(graderSourceFor({}, {})).toEqual({ kind: "snapshot" });
    const suite = fs.mkdtempSync(path.join(process.cwd(), ".test-suite-"));
    dirs.push(suite);
    fs.writeFileSync(path.join(suite, "a.json"), JSON.stringify({ id: "a", input: "t" }));
    const source = graderSourceFor({ suite }, {});
    expect(source.kind).toBe("suite");
    if (source.kind === "suite") expect(source.tests.map((test) => test.id)).toEqual(["a"]);
  });
});
