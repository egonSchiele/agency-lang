import * as fs from "fs";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { buildRunsListing } from "@/runDirectory/list.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { evalGrade, gradersFor, validateGradeTarget } from "./grade.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** A finished run directory with one successful trace, as eval run writes it. */
function makeRunDir(output: string): string {
  const runDir = writeRunDirectory({ test: { id: "a", goal: "g", input: "t" }, output });
  dirs.push(runDir);
  return runDir;
}

/**
 * A grading module that scores by output length. Written inside the package, not
 * a temp dir, so its `import "agency-lang/eval"` resolves against the workspace
 * node_modules — the same reason optimize.test.ts does this.
 */
function makeGraders(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".test-grading-"));
  dirs.push(dir);
  const file = path.join(dir, "graders.ts");
  fs.writeFileSync(
    file,
    `import { grader } from "agency-lang/eval";
export default [grader(({ output }) => String(output).length / 10, { name: "len" })];`,
  );
  return file;
}

describe("evalGrade", () => {
  it("scores a run directory and records one complete grading pass", async () => {
    const runDir = makeRunDir("hello");

    const result = await evalGrade([runDir], { graders: makeGraders(), config: {} });

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
      completesPass: true,
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

    await evalGrade([runDir], { graders: makeGraders(), out, config: {} });

    expect(JSON.parse(fs.readFileSync(out, "utf8")).mean).toBeCloseTo(0.5);
    expect(fs.existsSync(path.join(runDir, "annotations.jsonl"))).toBe(true);
  });

  it("a second pass appends beside the first and becomes the effective one", async () => {
    const runDir = makeRunDir("hello");
    const graders = makeGraders(); // the SAME module both times: one annotator, two passes

    await evalGrade([runDir], { graders, config: {} });
    await evalGrade([runDir], { graders, config: {} });

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
    writeRunDirectory({ test: { id: "a", input: "t" }, output: "hello" }, path.join(group, "a"));
    writeRunDirectory(
      { test: { id: "b", input: "t" }, output: "hello world" },
      path.join(group, "b"),
    );
    fs.writeFileSync(path.join(group, "notes.txt"), "not a run");

    const result = await evalGrade([group], { graders: makeGraders(), config: {} });

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
    writeRunDirectory({ test: { id: "a", input: "t" }, output: "hello" }, path.join(group, "a"));
    writeRunDirectory({ test: { id: "b", input: "t" }, output: "bye" }, path.join(group, "b"));
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".test-grading-"));
    dirs.push(dir);
    const file = path.join(dir, "graders.ts");
    fs.writeFileSync(
      file,
      `import { grader } from "agency-lang/eval";
export default [grader(({ output }) => output === "hello", { name: "gate", mustPass: true })];`,
    );

    const result = await evalGrade([group], { graders: file, config: {} });

    expect(result.runs.map((run) => run.grading.objective)).toEqual([1, 0]);
    expect(result.gatesPassed).toBe(false);
    expect(result.mean).toBeCloseTo(0.5);
  });

  it("several paths: every run found is graded once, in walk order", async () => {
    const a = makeRunDir("hello");
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    writeRunDirectory({ test: { id: "b", input: "t" }, output: "hello" }, path.join(group, "b"));

    const result = await evalGrade([a, group], { graders: makeGraders(), config: {} });

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
    writeRunDirectory({ test: { id: "a", input: "t" }, output: "hello" }, a);
    writeRunDirectory(
      { test: { id: "b", input: "t" }, output: "hello world" },
      path.join(group, "b"),
    );

    const result = await evalGrade([group, a], { graders: makeGraders(), config: {} });

    expect(result.runs.map((run) => path.basename(run.dir))).toEqual(["a", "b"]);
    expect(result.mean).toBeCloseTo((0.5 + 1.1) / 2);
    const rows = readRunDirectory(a, { reportWarning: () => {} }).annotationRows;
    expect(rows.filter((row) => row.kind === "score")).toHaveLength(1);
  });

  it("a symlink alias of a run directory is the same run: graded once", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    const a = path.join(group, "a");
    writeRunDirectory({ test: { id: "a", input: "t" }, output: "hello" }, a);
    const alias = path.join(group, "alias");
    fs.symlinkSync(a, alias, "dir");

    const result = await evalGrade([a, alias], { graders: makeGraders(), config: {} });

    expect(result.runs).toHaveLength(1);
    const rows = readRunDirectory(a, { reportWarning: () => {} }).annotationRows;
    expect(rows.filter((row) => row.kind === "score")).toHaveLength(1);
  });

  it("an errored run scores zero in eval grade but has no score row, so the listing mean leaves it out", async () => {
    const group = fs.mkdtempSync(path.join(process.cwd(), ".test-group-"));
    dirs.push(group);
    writeRunDirectory({ test: { id: "a", input: "t" }, output: "hello" }, path.join(group, "a"));
    writeRunDirectory(
      { test: { id: "b", input: "t" }, output: "hello", ended: "error" },
      path.join(group, "b"),
    );

    const result = await evalGrade([group], { graders: makeGraders(), config: {} });

    expect(result.mean).toBeCloseTo(0.5 / 2);
    const listing = buildRunsListing(
      [path.join(group, "a"), path.join(group, "b")].map((dir) =>
        readRunDirectory(dir, { reportWarning: () => {} }),
      ),
    );
    expect(listing.gradedCount).toBe(1);
    expect(listing.meanScore).toBeCloseTo(0.5);
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

  it("refuses --goal together with --graders", () => {
    expect(() => validateGradeTarget([makeRunDir("x")], { goal: "g", graders: "g.ts" })).toThrow(
      /only one of --graders or --goal/,
    );
  });

  it("--goal sets aside a configured grading module and runs the goal judge", async () => {
    // A configured module carries its own criteria, just as --graders does; --goal
    // names the criterion, so it must reach the bundled goal judge, not the module.
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".test-grading-"));
    dirs.push(dir);
    const file = path.join(dir, "graders.ts");
    fs.writeFileSync(
      file,
      `import { grader } from "agency-lang/eval";
export default [grader(() => 1, { name: "module" })];`,
    );
    const withGoal = await gradersFor({ goal: "be nice" }, { eval: { graders: file } });
    expect(withGoal?.mode).toBe("fallback");
    expect(withGoal?.graders.map((g) => g.name())).toEqual(["goal"]);
    expect(withGoal?.graders[0].annotator().kind).toBe("judge");
    // Without --goal the configured module is the fallback, as before.
    const withoutGoal = await gradersFor({}, { eval: { graders: file } });
    expect(withoutGoal?.graders.map((g) => g.name())).toEqual(["module"]);
  });
});
