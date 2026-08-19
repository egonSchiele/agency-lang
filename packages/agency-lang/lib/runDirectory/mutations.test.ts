import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { computeCodeIdentity } from "./codeIdentity.js";
import {
  wrapTracesAsRunDirectories,
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

/** A run directory written by hand; the reader still accepts several traces. */
function directoryWithTraces(...traceIds: string[]): string {
  const dir = tempDir();
  fs.writeFileSync(
    runDirPaths(dir).statelog,
    traceIds.map((id) => agentStartLine(id)).join("\n") + "\n",
  );
  return dir;
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

describe("wrapTracesAsRunDirectories", () => {
  it("writes one run directory per trace, with code where it matches, and skips existing children", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const entry = path.join(project, "main.agency");
    const identity = computeCodeIdentity(entry);
    const group = tempDir();
    const log = statelogFile(
      agentStartLine("t1", identity),
      statelogLine("t1", "agentEnd"),
      agentStartLine("t2"),
      agentStartLine("t3"),
    );

    const result = wrapTracesAsRunDirectories({
      groupDir: group,
      statelogFiles: [log],
      codeEntries: [entry],
      annotationFiles: [],
    });
    expect(result.written).toEqual(["t1", "t2", "t3"].map((id) => path.join(group, id)));
    expect(result.skipped).toEqual([]);
    const t1 = runDirPaths(path.join(group, "t1"));
    expect(readRunDirectory(t1.dir, quiet).traces.map((trace) => trace.traceId)).toEqual(["t1"]);
    expect(fs.existsSync(path.join(t1.codeDir, "main.agency"))).toBe(true);
    expect(fs.existsSync(runDirPaths(path.join(group, "t2")).codeDir)).toBe(false);
    expect(fs.existsSync(t1.lock)).toBe(false);
    expect(fs.existsSync(path.join(group, ".staging"))).toBe(false);

    const again = wrapTracesAsRunDirectories({
      groupDir: group,
      statelogFiles: [log],
      codeEntries: [],
      annotationFiles: [],
    });
    expect(again.written).toEqual([]);
    expect(again.skipped.map((skip) => skip.traceId)).toEqual(["t1", "t2", "t3"]);
  });

  it("--trace picks one; a workdir needs one trace; a conflicting id writes nothing", () => {
    const group = tempDir();
    const log = statelogFile(agentStartLine("t1"), agentStartLine("t2"));
    const workdir = writeProject({ "out.txt": "done" });
    expect(() =>
      wrapTracesAsRunDirectories({
        groupDir: group,
        statelogFiles: [log],
        codeEntries: [],
        workdir: { sourceDir: workdir },
        annotationFiles: [],
      }),
    ).toThrow(/--trace/);
    const one = wrapTracesAsRunDirectories({
      groupDir: group,
      statelogFiles: [log],
      trace: "t2",
      codeEntries: [],
      workdir: { sourceDir: workdir },
      annotationFiles: [],
    });
    expect(one.written).toEqual([path.join(group, "t2")]);
    const t2 = runDirPaths(path.join(group, "t2"));
    expect(fs.existsSync(path.join(t2.workdirDir, "out.txt"))).toBe(true);
    expect(fs.existsSync(t2.workdirSidecar)).toBe(true);

    const conflicting = statelogFile(statelogLine("t1", "agentStart", { changed: true }));
    expect(() =>
      wrapTracesAsRunDirectories({
        groupDir: group,
        statelogFiles: [log, conflicting],
        codeEntries: [],
        annotationFiles: [],
      }),
    ).toThrow(/t1/);
    expect(fs.existsSync(path.join(group, "t1"))).toBe(false);
  });

  it("--trace that matches nothing or several is an error; an id that would escape the group is refused", () => {
    const group = tempDir();
    const log = statelogFile(agentStartLine("abc-1"), agentStartLine("abc-2"));
    const request = { groupDir: group, statelogFiles: [log], codeEntries: [], annotationFiles: [] };
    expect(() => wrapTracesAsRunDirectories({ ...request, trace: "zzz" })).toThrow(/No trace/);
    expect(() => wrapTracesAsRunDirectories({ ...request, trace: "abc" })).toThrow(/ambiguous/);
    // A unique prefix is enough.
    expect(wrapTracesAsRunDirectories({ ...request, trace: "abc-2" }).written).toEqual([
      path.join(group, "abc-2"),
    ]);

    const escaping = tempDir();
    expect(() =>
      wrapTracesAsRunDirectories({
        groupDir: escaping,
        statelogFiles: [statelogFile(agentStartLine("../escaped"))],
        codeEntries: [],
        annotationFiles: [],
      }),
    ).toThrow(/outside/);
    expect(fs.existsSync(path.join(escaping, "..", "escaped"))).toBe(false);
  });

  it("routes annotation rows to the child their trace names, idempotently, and refuses orphans", () => {
    const source = tempDir();
    wrapTracesAsRunDirectories({
      groupDir: source,
      statelogFiles: [statelogFile(agentStartLine("t1"))],
      codeEntries: [],
      annotationFiles: [],
    });
    const sourceRun = path.join(source, "t1");
    recordNote({ dir: sourceRun, traceId: "t1", annotator: human, text: "slow" });
    const rows = runDirPaths(sourceRun).annotations;

    const group = tempDir();
    wrapTracesAsRunDirectories({
      groupDir: group,
      statelogFiles: [statelogFile(agentStartLine("t1"), agentStartLine("t2"))],
      codeEntries: [],
      annotationFiles: [rows, rows],
    });
    expect(readRunDirectory(path.join(group, "t1"), quiet).annotationRows).toHaveLength(1);
    expect(readRunDirectory(path.join(group, "t2"), quiet).annotationRows).toHaveLength(0);

    const other = tempDir();
    expect(() =>
      wrapTracesAsRunDirectories({
        groupDir: other,
        statelogFiles: [statelogFile(agentStartLine("t9"))],
        codeEntries: [],
        annotationFiles: [rows],
      }),
    ).toThrow(/t1/);
    expect(fs.existsSync(path.join(other, "t9"))).toBe(false);
  });
});

describe("recordCompletedRun", () => {
  it("writes the staged statelog, attaches code and workdir, and appends the run row", () => {
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
      workdir: { sourceDir: workdir },
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
    expect(fs.existsSync(path.join(runDirPaths(dir).workdirDir, "out.txt"))).toBe(true);
    expect(fs.existsSync(path.join(runDirPaths(dir).codeDir, "main.agency"))).toBe(true);
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
    ).toThrow(/t2.*staged statelog holds t1/);
    expect(fs.existsSync(runDirPaths(dir).statelog)).toBe(false);
    expect(fs.existsSync(runDirPaths(dir).annotations)).toBe(false);
  });

  it("still records a run that produced no trace at all, since the row is its only record", () => {
    const dir = tempDir();
    const staged = statelogFile();
    const result = recordCompletedRun({
      dir,
      stagedStatelogFile: staged,
      run: { traceId: "t-died-early", ...run },
    });
    expect(result.snapshot.effectiveAnnotations["t-died-early"].run?.kind).toBe("run");
    expect(result.snapshot.traces).toEqual([]);
  });

  it("refuses a staged statelog with a malformed line in the middle, writing nothing", () => {
    const dir = tempDir();
    const staged = statelogFile(agentStartLine("t1"), "{ not json", statelogLine("t1", "agentEnd"));
    expect(() =>
      recordCompletedRun({ dir, stagedStatelogFile: staged, run: { traceId: "t1", ...run } }),
    ).toThrow(/could not be parsed/);
    expect(fs.existsSync(runDirPaths(dir).statelog)).toBe(false);
    const group = tempDir();
    expect(() =>
      wrapTracesAsRunDirectories({
        groupDir: group,
        statelogFiles: [staged],
        codeEntries: [],
        annotationFiles: [],
      }),
    ).toThrow(/could not be parsed/);
    expect(fs.existsSync(path.join(group, "t1"))).toBe(false);
  });
});

describe("recordNote", () => {
  it("is idempotent and refuses an unknown trace", () => {
    const dir = directoryWithTraces("t1");
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
    return directoryWithTraces("t1", "t2");
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
    const dir = directoryWithTraces("t1");
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
