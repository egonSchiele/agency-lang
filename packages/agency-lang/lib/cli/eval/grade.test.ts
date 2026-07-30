import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { evalGrade } from "./grade.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** A finished run directory with one successful input, laid out as eval run writes it. */
function makeRunDir(output: string): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-grade-"));
  dirs.push(runDir);
  const inputDir = path.join(runDir, "inputs", "a");
  fs.mkdirSync(path.join(inputDir, "workdir"), { recursive: true });
  fs.mkdirSync(path.join(inputDir, "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "input.json"),
    JSON.stringify({ id: "a", goal: "g", args: {} }),
  );
  fs.writeFileSync(path.join(inputDir, "agent", "eval-record.json"), JSON.stringify({
    traceId: "t", recordVersion: 2, formatVersion: 1, durationMs: 1, source: "s",
    evalValues: [], evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
    threads: [], events: [], interrupts: [], errors: [], incomplete: [],
    metrics: {
      llmCalls: 0, toolStarts: 0, toolEnds: 0, models: [],
      tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0, toolCounts: {},
    },
    warnings: [],
  }));
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    runId: "r", runDir, agentLabel: "a:main", okCount: 1, errorCount: 0,
    inputs: [{
      inputId: "a",
      status: "success",
      evalRecordPath: path.join(inputDir, "agent", "eval-record.json"),
      statelogPath: path.join(inputDir, "agent", "statelog.jsonl"),
      workdirPath: path.join(inputDir, "workdir"),
    }],
  }));
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
  fs.writeFileSync(file, `import { grader } from "agency-lang/eval";
export default [grader(({ output }) => String(output).length / 10, { name: "len" })];`);
  return file;
}

describe("evalGrade", () => {
  it("scores a finished run and writes grading.json without touching summary.json", async () => {
    const runDir = makeRunDir("hello");
    const before = fs.readFileSync(path.join(runDir, "summary.json"), "utf8");

    const grading = await evalGrade(runDir, { graders: makeGraders(), config: {} });

    expect(grading.objective).toBeCloseTo(0.5);
    expect(grading.graders).toEqual(["len"]);
    const written = JSON.parse(fs.readFileSync(path.join(runDir, "verifier", "grading.json"), "utf8"));
    expect(written.objective).toBeCloseTo(0.5);
    expect(fs.readFileSync(path.join(runDir, "summary.json"), "utf8")).toBe(before);
  });

  it("honors -o and leaves grading.json absent", async () => {
    const runDir = makeRunDir("hello");
    const out = path.join(runDir, "custom.json");

    await evalGrade(runDir, { graders: makeGraders(), out, config: {} });

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "grading.json"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "verifier"))).toBe(false);
  });

  it("writes verifier/grading.json first, then verifier-N by highest existing + 1", async () => {
    const runDir = makeRunDir("hello");

    await evalGrade(runDir, { graders: makeGraders(), config: {} });
    await evalGrade(runDir, { graders: makeGraders(), config: {} });
    // A deleted number stays retired: with verifier and verifier-2 present,
    // removing verifier-2 and planting verifier-4 must produce verifier-5.
    fs.rmSync(path.join(runDir, "verifier-2"), { recursive: true, force: true });
    fs.mkdirSync(path.join(runDir, "verifier-4"));
    await evalGrade(runDir, { graders: makeGraders(), config: {} });

    expect(fs.existsSync(path.join(runDir, "verifier", "grading.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verifier-5", "grading.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verifier-2"))).toBe(false);
  });
});
