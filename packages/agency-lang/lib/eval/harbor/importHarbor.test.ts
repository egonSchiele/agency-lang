import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { findRunDirectories } from "@/runDirectory/findRuns.js";
import { summarizeRunDirectory } from "@/runDirectory/list.js";
import { recordCompletedRun } from "@/runDirectory/mutations.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";
import { agentStartLine, statelogLine, tempDir } from "@/runDirectory/testFixtures.js";

import { importHarbor } from "./importHarbor.js";
import { writeHarborTrial, type FakeHarborTrial } from "./testFixtures.js";

const quiet = { reportWarning: (): void => {} };

function traceLines(traceId: string): string[] {
  return [
    agentStartLine(traceId),
    statelogLine(traceId, "promptCompletion", {
      model: '"glm"',
      usage: { inputTokens: 10, outputTokens: 2 },
      cost: { totalCost: 0.01 },
    }),
    statelogLine(traceId, "agentEnd", { result: "done", timeTaken: 5 }),
  ];
}

function harborTrial(overrides: Partial<FakeHarborTrial> & { name: string }): FakeHarborTrial {
  return {
    taskName: "swe-bench/astropy__astropy-12907",
    source: "swe-bench-verified",
    startedAt: "2026-11-13T10:00:00Z",
    rewards: { reward: 1 },
    statelogLines: traceLines(`trace-${overrides.name}`),
    ...overrides,
  };
}

function summaryAt(dir: string) {
  return summarizeRunDirectory(readRunDirectory(dir, quiet));
}

function filesUnder(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      files[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  }
  return files;
}

describe("importHarbor", () => {
  it("imports a trial that runs list reads", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "k1-agency-minimal");
    writeHarborTrial(jobDir, harborTrial({ name: "a__1" }));
    const outDir = path.join(root, "out");
    const result = importHarbor({ jobDirs: [jobDir], outDir, reasoning: "high" });
    const runDir = path.join(outDir, "k1-agency-minimal", "astropy__astropy-12907", "1");
    expect(result.outcomes).toEqual([{ status: "imported", dir: runDir }]);
    expect(result.uploadPath).toBe(path.join(outDir, "k1-agency-minimal"));
    expect(summaryAt(runDir)).toMatchObject({
      testId: "astropy__astropy-12907",
      batch: "k1-agency-minimal",
      trial: 1,
      score: 1,
      status: "ok",
      benchmark: "swe-bench-verified",
      models: [expect.objectContaining({ name: "glm", reasoning: "high" })],
    });
  });

  it("a trial without a trace is a silent run with no score that discovery finds", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(
      jobDir,
      harborTrial({
        name: "a__1",
        rewards: null,
        exception: { type: "NonZeroAgentExitCodeError", message: "firewall setup failed" },
        statelogLines: undefined,
      }),
    );
    const outDir = path.join(root, "out");
    importHarbor({ jobDirs: [jobDir], outDir });
    const runDir = path.join(outDir, "job", "astropy__astropy-12907", "1");
    expect(summaryAt(runDir)).toMatchObject({ ended: "void", score: null });
    expect(findRunDirectories([path.join(outDir, "job")])).toEqual([runDir]);
  });

  it("a second import changes nothing", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(jobDir, harborTrial({ name: "a__1" }));
    writeHarborTrial(
      jobDir,
      harborTrial({
        name: "b__1",
        taskName: "swe-bench/b",
        rewards: null,
        statelogLines: undefined,
      }),
    );
    const outDir = path.join(root, "out");
    importHarbor({ jobDirs: [jobDir], outDir });
    const before = filesUnder(outDir);
    const again = importHarbor({ jobDirs: [jobDir], outDir });
    expect(again.outcomes.map((outcome) => outcome.status)).toEqual(["present", "present"]);
    expect(filesUnder(outDir)).toEqual(before);
  });

  it("a run cut off before its scores gets only its scores", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    const trialDir = writeHarborTrial(jobDir, harborTrial({ name: "a__1" }));
    const outDir = path.join(root, "out");
    const runDir = path.join(outDir, "job", "astropy__astropy-12907", "1");
    fs.mkdirSync(runDir, { recursive: true });
    recordCompletedRun({
      dir: runDir,
      stagedStatelogFile: path.join(trialDir, "agent", "statelog.jsonl"),
      run: {
        traceId: "trace-a__1",
        annotator: { kind: "harness", id: "harbor-import@test" },
        payload: {
          kind: "run",
          test: { id: "astropy__astropy-12907" },
          suite: null,
          ended: "ok",
          flags: { harborJob: "job", harborTrial: "a__1" },
          batch: "job",
          trial: 1,
          benchmark: "swe-bench-verified",
        },
      },
    });
    const result = importHarbor({ jobDirs: [jobDir], outDir });
    expect(result.outcomes).toEqual([{ status: "scored", dir: runDir }]);
    const snapshot = readRunDirectory(runDir, quiet);
    expect(snapshot.annotationRows.filter((row) => row.kind === "run")).toHaveLength(1);
    expect(summaryAt(runDir)).toMatchObject({ score: 1 });
  });

  it("importing in a different order fails the moved runs, naming both", () => {
    const root = tempDir("harbor-");
    const first = path.join(root, "job1");
    const second = path.join(root, "job2");
    writeHarborTrial(first, harborTrial({ name: "a__1" }));
    writeHarborTrial(second, harborTrial({ name: "a__2" }));
    const outDir = path.join(root, "out");
    importHarbor({ jobDirs: [first, second], outDir, batch: "k" });
    const reordered = importHarbor({ jobDirs: [second, first], outDir, batch: "k" });
    expect(reordered.outcomes).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/job1\/a__1.*job2\/a__2|job2\/a__2.*job1\/a__1/),
      }),
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("a trace with two trace ids fails that trial only", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(
      jobDir,
      harborTrial({ name: "a__1", statelogLines: [...traceLines("t1"), ...traceLines("t2")] }),
    );
    writeHarborTrial(jobDir, harborTrial({ name: "b__1", taskName: "swe-bench/b" }));
    const result = importHarbor({ jobDirs: [jobDir], outDir: path.join(root, "out") });
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["failed", "imported"]);
  });

  it("a silent trial planned into a folder holding another trial's trace fails and keeps the trace", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(
      jobDir,
      harborTrial({ name: "a__1", rewards: null, statelogLines: undefined }),
    );
    const outDir = path.join(root, "out");
    const runDir = path.join(outDir, "job", "astropy__astropy-12907", "1");
    fs.mkdirSync(runDir, { recursive: true });
    const statelog = path.join(runDir, "statelog.jsonl");
    fs.writeFileSync(statelog, traceLines("other").join("\n") + "\n");
    const before = fs.readFileSync(statelog, "utf8");
    const result = importHarbor({ jobDirs: [jobDir], outDir });
    expect(result.outcomes).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(fs.readFileSync(statelog, "utf8")).toBe(before);
  });

  it.each(["../x", "a/b", "", "."])("refuses --batch %j", (batch) => {
    const root = tempDir("harbor-");
    expect(() => importHarbor({ jobDirs: [root], outDir: root, batch })).toThrow(
      "import-harbor: --batch must be one plain folder name",
    );
  });

  it("reports progress once per trial", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(jobDir, harborTrial({ name: "a__1" }));
    writeHarborTrial(jobDir, harborTrial({ name: "b__1", taskName: "swe-bench/b" }));
    const lines: string[] = [];
    importHarbor({
      jobDirs: [jobDir],
      outDir: path.join(root, "out"),
      reportProgress: (line) => lines.push(line),
    });
    expect(lines).toEqual(["[1/2] imported astropy__astropy-12907/1", "[2/2] imported b/1"]);
  });

  it("--batch is required for several job folders or a trials file", () => {
    const root = tempDir("harbor-");
    const trialsFile = path.join(root, "trials.txt");
    fs.writeFileSync(trialsFile, "");
    const message = "import-harbor: --batch is required unless importing one job folder";
    expect(() => importHarbor({ jobDirs: [root, root], outDir: root })).toThrow(message);
    expect(() => importHarbor({ jobDirs: [], trialsFile, outDir: root })).toThrow(message);
  });
});
