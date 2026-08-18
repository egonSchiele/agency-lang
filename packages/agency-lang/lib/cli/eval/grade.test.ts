import * as fs from "fs";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { evalGrade } from "./grade.js";

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
  const runDir = writeRunDirectory([{ test: { id: "a", goal: "g", input: "t" }, output }]);
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

    const grading = await evalGrade(runDir, { graders: makeGraders(), config: {} });

    expect(grading.objective).toBeCloseTo(0.5);
    expect(grading.graders).toEqual(["len"]);
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

    await evalGrade(runDir, { graders: makeGraders(), out, config: {} });

    expect(JSON.parse(fs.readFileSync(out, "utf8")).objective).toBeCloseTo(0.5);
    expect(fs.existsSync(path.join(runDir, "annotations.jsonl"))).toBe(true);
  });

  it("a second pass appends beside the first and becomes the effective one", async () => {
    const runDir = makeRunDir("hello");
    const graders = makeGraders(); // the SAME module both times: one annotator, two passes

    await evalGrade(runDir, { graders, config: {} });
    await evalGrade(runDir, { graders, config: {} });

    const snapshot = readRunDirectory(runDir, { reportWarning: () => {} });
    const scores = snapshot.annotationRows.filter((row) => row.kind === "score");
    expect(scores).toHaveLength(2);
    expect(new Set(scores.map((row) => (row.kind === "score" ? row.passId : ""))).size).toBe(2);
    const effective = snapshot.effectiveAnnotations["trace-1"].scores;
    expect(Object.values(effective)[0].id).toBe(scores[1].id);
  });
});
