import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { computeCodeIdentity } from "./codeIdentity.js";
import {
  addToRunDirectory,
  recordCompletedRun,
  recordGradingPass,
  recordNote,
  type ScoreDraft,
} from "./mutations.js";
import { readRunDirectory, runDirPaths } from "./runDir.js";
import { agentStartLine, statelogLine, tempDir, writeProject } from "./testFixtures.js";

const human = { kind: "human" as const, id: "adit" };
const grader = { kind: "grader" as const, id: "graders.ts@aaa" };
const quiet = { reportWarning: () => {} };

function statelogFile(...lines: string[]): string {
  const file = path.join(tempDir("log-"), "statelog.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function scoreDraft(traceId: string, name: string, value: number): ScoreDraft {
  return {
    traceId,
    annotator: grader,
    name,
    score: { kind: "scalar", value },
    weight: 1,
    mustPass: false,
  };
}

describe("addToRunDirectory", () => {
  it("adds statelogs, code, workdir and annotations in one request", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const entry = path.join(project, "main.agency");
    const identity = computeCodeIdentity(entry);
    const dir = tempDir();
    const log = statelogFile(agentStartLine("t1", identity), statelogLine("t1", "agentEnd"));
    const workdir = writeProject({ "out.txt": "done" });

    const result = addToRunDirectory({
      dir,
      statelogFiles: [log],
      codeEntries: [entry],
      workdir: { traceId: "t1", sourceDir: workdir },
      annotationFiles: [],
    });
    expect(result.statelogs).toEqual({ added: 1, skipped: 0 });
    expect(result.code).toEqual({ added: 1, skipped: 0 });
    expect(result.workdirs).toEqual({ added: 1, skipped: 0 });
    expect(result.snapshot.traces.map((trace) => trace.traceId)).toEqual(["t1"]);
    const paths = runDirPaths(dir);
    expect(fs.existsSync(path.join(paths.codeDir, identity.closureHash, "main.agency"))).toBe(true);
    expect(fs.existsSync(path.join(paths.workdirDir, "t1", "out.txt"))).toBe(true);
    expect(fs.existsSync(paths.lock)).toBe(false);

    const again = addToRunDirectory({
      dir,
      statelogFiles: [log],
      codeEntries: [entry],
      annotationFiles: [],
    });
    expect(again.statelogs).toEqual({ added: 0, skipped: 1 });
    expect(again.code).toEqual({ added: 0, skipped: 1 });
  });

  it("leaves every target byte-identical when any statelog conflicts", () => {
    const dir = tempDir();
    const first = statelogFile(agentStartLine("t1"));
    addToRunDirectory({ dir, statelogFiles: [first], codeEntries: [], annotationFiles: [] });
    const paths = runDirPaths(dir);
    const before = fs.readFileSync(paths.statelog, "utf8");

    const fresh = statelogFile(agentStartLine("t2"));
    const conflicting = statelogFile(statelogLine("t1", "agentStart", { changed: true }));
    expect(() =>
      addToRunDirectory({
        dir,
        statelogFiles: [fresh, conflicting],
        codeEntries: [],
        annotationFiles: [],
      }),
    ).toThrow(/t1/);
    expect(fs.readFileSync(paths.statelog, "utf8")).toBe(before);
    expect(fs.existsSync(paths.lock)).toBe(false);
  });

  it("imports annotation rows idempotently", () => {
    const dir = tempDir();
    addToRunDirectory({
      dir,
      statelogFiles: [statelogFile(agentStartLine("t1"))],
      codeEntries: [],
      annotationFiles: [],
    });
    recordNote({ dir, traceId: "t1", annotator: human, text: "slow" });
    const other = tempDir();
    addToRunDirectory({
      dir: other,
      statelogFiles: [statelogFile(agentStartLine("t1"))],
      codeEntries: [],
      annotationFiles: [],
    });
    const imported = addToRunDirectory({
      dir: other,
      statelogFiles: [],
      codeEntries: [],
      annotationFiles: [runDirPaths(dir).annotations, runDirPaths(dir).annotations],
    });
    expect(imported.annotations).toEqual({ added: 1, skipped: 1 });
  });
});

describe("recordCompletedRun", () => {
  it("merges the staged statelog, attaches code and workdir, and appends the run row", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const entry = path.join(project, "main.agency");
    const dir = tempDir();
    const staged = statelogFile(
      agentStartLine("t1", computeCodeIdentity(entry)),
      statelogLine("t1", "agentEnd"),
    );
    const workdir = writeProject({ "out.txt": "x" });
    const result = recordCompletedRun({
      dir,
      stagedStatelogFile: staged,
      codeEntry: entry,
      workdir: { traceId: "t1", sourceDir: workdir },
      run: {
        traceId: "t1",
        annotator: { kind: "harness", id: "eval@test" },
        payload: {
          kind: "run",
          test: { id: "a", input: "hi" },
          suite: null,
          ended: "ok",
          flags: {},
        },
      },
    });
    expect(result.annotation.kind).toBe("run");
    expect(result.snapshot.effectiveAnnotations.t1.run?.id).toBe(result.annotation.id);
    expect(fs.existsSync(path.join(runDirPaths(dir).workdirDir, "t1", "out.txt"))).toBe(true);
    expect(fs.existsSync(runDirPaths(dir).lock)).toBe(false);
  });
});

describe("recordCompletedRun preflight", () => {
  const run = {
    annotator: { kind: "harness" as const, id: "eval@test" },
    payload: {
      kind: "run" as const,
      test: { id: "a", input: "hi" },
      suite: null,
      ended: "ok" as const,
      flags: {},
    },
  };

  it("refuses a run row whose trace is neither in the directory nor in the staged statelog", () => {
    const dir = tempDir();
    const staged = statelogFile(agentStartLine("t1"), statelogLine("t1", "agentEnd"));
    expect(() =>
      recordCompletedRun({ dir, stagedStatelogFile: staged, run: { traceId: "t2", ...run } }),
    ).toThrow(/t2.*staged statelog.*t1/);
    expect(fs.existsSync(runDirPaths(dir).statelog)).toBe(false);
    expect(fs.existsSync(runDirPaths(dir).annotations)).toBe(false);
  });

  it("refuses a staged statelog with a malformed line in the middle, writing nothing", () => {
    const dir = tempDir();
    const staged = statelogFile(agentStartLine("t1"), "{ not json", statelogLine("t1", "agentEnd"));
    expect(() =>
      recordCompletedRun({ dir, stagedStatelogFile: staged, run: { traceId: "t1", ...run } }),
    ).toThrow(/could not be parsed/);
    expect(fs.existsSync(runDirPaths(dir).statelog)).toBe(false);
    expect(() =>
      addToRunDirectory({ dir, statelogFiles: [staged], codeEntries: [], annotationFiles: [] }),
    ).toThrow(/could not be parsed/);
    expect(fs.existsSync(runDirPaths(dir).statelog)).toBe(false);
  });
});

describe("recordNote", () => {
  it("is idempotent and refuses an unknown trace", () => {
    const dir = tempDir();
    addToRunDirectory({
      dir,
      statelogFiles: [statelogFile(agentStartLine("t1"))],
      codeEntries: [],
      annotationFiles: [],
    });
    const first = recordNote({ dir, traceId: "t1", annotator: human, text: "slow" });
    const second = recordNote({ dir, traceId: "t1", annotator: human, text: "slow" });
    expect(second.id).toBe(first.id);
    expect(readRunDirectory(dir, quiet).annotationRows).toHaveLength(1);
    expect(() => recordNote({ dir, traceId: "nope", annotator: human, text: "x" })).toThrow(
      /No trace/,
    );
  });
});

describe("recordGradingPass", () => {
  function directory(): string {
    const dir = tempDir();
    addToRunDirectory({
      dir,
      statelogFiles: [statelogFile(agentStartLine("t1"), agentStartLine("t2"))],
      codeEntries: [],
      annotationFiles: [],
    });
    return dir;
  }

  it("records a complete pass that becomes effective; a second pass supersedes it", () => {
    const dir = directory();
    const first = recordGradingPass({
      dir,
      scores: [scoreDraft("t1", "cheap", 0.2), scoreDraft("t2", "cheap", 0.4)],
    });
    expect(first.annotations).toHaveLength(2);
    expect(first.annotations.map((row) => row.kind === "score" && row.completesPass)).toEqual([
      false,
      true,
    ]);
    expect(first.snapshot.effectiveAnnotations.t1.scores["grader:graders.ts@aaa:cheap"].id).toBe(
      first.annotations[0].id,
    );

    const second = recordGradingPass({
      dir,
      scores: [scoreDraft("t1", "cheap", 0.2), scoreDraft("t2", "cheap", 0.4)],
    });
    expect(second.passId).not.toBe(first.passId);
    expect(second.snapshot.annotationRows).toHaveLength(4);
    expect(second.snapshot.effectiveAnnotations.t1.scores["grader:graders.ts@aaa:cheap"].id).toBe(
      second.annotations[0].id,
    );
  });

  it("a pass that fails before its final row leaves prior effective scores unchanged", () => {
    const dir = directory();
    const first = recordGradingPass({
      dir,
      scores: [scoreDraft("t1", "cheap", 0.2), scoreDraft("t2", "cheap", 0.4)],
    });
    // Simulate a crash mid-pass: write only the first row of a new pass by hand.
    const partial = recordGradingPass({
      dir,
      scores: [scoreDraft("t1", "cheap", 0.9), scoreDraft("t2", "cheap", 0.9)],
    });
    const paths = runDirPaths(dir);
    const rows = fs.readFileSync(paths.annotations, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(paths.annotations, rows.slice(0, 3).join("\n") + "\n"); // drop the completing row of pass 2
    const snapshot = readRunDirectory(dir, quiet);
    expect(snapshot.effectiveAnnotations.t1.scores["grader:graders.ts@aaa:cheap"].id).toBe(
      first.annotations[0].id,
    );
    expect(partial.passId).toBeDefined();
  });

  it("refuses an empty pass instead of minting a pass id for nothing", () => {
    expect(() => recordGradingPass({ dir: directory(), scores: [] })).toThrow(/at least one/);
  });

  it("refuses when any score names an unknown trace, recording nothing", () => {
    const dir = directory();
    expect(() =>
      recordGradingPass({ dir, scores: [scoreDraft("t1", "a", 1), scoreDraft("zzz", "a", 1)] }),
    ).toThrow(/zzz/);
    expect(readRunDirectory(dir, quiet).annotationRows).toHaveLength(0);
  });
});

describe("torn-tail repair", () => {
  it("truncates a partial final line before appending", () => {
    const dir = tempDir();
    addToRunDirectory({
      dir,
      statelogFiles: [statelogFile(agentStartLine("t1"))],
      codeEntries: [],
      annotationFiles: [],
    });
    const paths = runDirPaths(dir);
    fs.appendFileSync(paths.annotations, '{"v":1,"id":"ann_torn');
    fs.appendFileSync(paths.statelog, '{"trace_id":"half');
    recordNote({ dir, traceId: "t1", annotator: human, text: "after the crash" });
    const annotationLines = fs.readFileSync(paths.annotations, "utf8").split("\n").filter(Boolean);
    expect(annotationLines).toHaveLength(1);
    expect(JSON.parse(annotationLines[0]).text).toBe("after the crash");
    expect(fs.readFileSync(paths.statelog, "utf8").endsWith("\n")).toBe(true);
    expect(fs.readFileSync(paths.statelog, "utf8")).not.toContain("half");
  });
});
