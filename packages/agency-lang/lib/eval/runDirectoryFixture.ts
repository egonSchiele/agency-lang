import * as fs from "fs";
import * as path from "path";

import type { RunOutcome } from "@/runDirectory/annotations.js";
import { recordCompletedRun } from "@/runDirectory/mutations.js";
import { runDirPaths } from "@/runDirectory/runDir.js";
import { finishedTraceLines, tempDir } from "@/runDirectory/testFixtures.js";

import type { Test } from "./runTypes.js";
import type { HarnessSnapshot } from "./grading/harnessSnapshot.js";
import type { GraderFilesSnapshot } from "./grading/graderFilesSnapshot.js";

/** One fake test run to write into a run directory. */
export type FakeRun = {
  test: Test;
  traceId?: string;
  /** The recorded output; undefined → the trace ends with no output. */
  output?: unknown;
  ended?: RunOutcome;
  errorMessage?: string;
  /** Files to place in the trace's workdir snapshot. */
  workdirFiles?: Record<string, string>;
  costUsd?: number;
  /** When false, no trace is written at all — a run that never started. */
  wroteStatelog?: boolean;
  /** The harness's agent label, recorded as `flags.agent` on the run row. */
  agentLabel?: string;
  /** Harness pairs to store under graders/ and record on the run row, as
   *  `eval run` does for a test directory with files/ and holdout/. */
  harness?: HarnessSnapshot;
  /** The test's grader-only files to store under graders/, as `eval run`
   *  does for a test directory with graderFiles/. */
  graderFiles?: GraderFilesSnapshot;
  /** Recorded on the run row, as `eval run` does for a suite invocation. */
  batch?: string;
  trial?: number;
};

/**
 * Write one run directory the way `eval run` does — the trace, its workdir,
 * and the `run` row — for tests of grading, labeling, the explorer, the
 * optimizer, and the CLI. Returns the directory. One run per directory is
 * the only shape writers produce and readers accept; a group of several is
 * `writeRunGroup`.
 */
export function writeRunDirectory(run: FakeRun, dir: string = tempDir("run-")): string {
  fs.mkdirSync(dir, { recursive: true });
  const statelog = runDirPaths(dir).statelog;
  if (!fs.existsSync(statelog)) {
    // The harness creates the statelog before running an input. It remains
    // empty when the test dies before its first event, so discovery still
    // recognizes the directory as a run.
    fs.writeFileSync(statelog, "");
  }
  const traceId = run.traceId ?? "trace-1";
  const staging = tempDir("staging-");
  let statelogFile: string | undefined;
  if (run.wroteStatelog !== false) {
    statelogFile = path.join(staging, "statelog.jsonl");
    fs.writeFileSync(
      statelogFile,
      finishedTraceLines(traceId, {
        output: run.output,
        input: run.test.input,
        costUsd: run.costUsd,
      }).join("\n") + "\n",
    );
  }
  let workdir: { sourceDir: string } | undefined;
  if (run.workdirFiles !== undefined && statelogFile !== undefined) {
    const source = path.join(staging, "workdir");
    for (const [rel, text] of Object.entries(run.workdirFiles)) {
      fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
      fs.writeFileSync(path.join(source, rel), text);
    }
    workdir = { sourceDir: source };
  }
  const ended = run.ended ?? "ok";
  recordCompletedRun({
    dir,
    stagedStatelogFile: statelogFile,
    workdir,
    gradersFiles: [...(run.harness?.files ?? []), ...(run.graderFiles?.files ?? [])],
    run: {
      traceId,
      annotator: { kind: "harness", id: "agency-eval@test" },
      payload: {
        kind: "run",
        test: run.test as never,
        suite: null,
        ended,
        flags: run.agentLabel === undefined ? {} : { agent: run.agentLabel },
        batch: run.batch,
        trial: run.trial,
        ...(run.harness === undefined ? {} : { harness: run.harness.records }),
        ...(run.graderFiles === undefined ? {} : { graderFiles: run.graderFiles.dirName }),
        ...(ended === "ok" ? {} : { error: run.errorMessage ?? `ended with ${ended}` }),
      },
    },
  });
  return dir;
}

/**
 * A group the way `eval run --out` writes one: one run directory per fake
 * run, at `<groupDir>/<test.id>/` (the trace id when the test has no id).
 * Child names are checked for clashes before anything is written, so a bad
 * call leaves no partial group. Returns the group directory.
 */
export function writeRunGroup(runs: FakeRun[], groupDir: string = tempDir("group-")): string {
  const children = runs.map((run) => ({
    run,
    dir: path.join(groupDir, run.test.id ?? run.traceId ?? "trace-1"),
  }));
  const clash = children.find(
    (child, index) => children.findIndex((other) => other.dir === child.dir) !== index,
  );
  if (clash !== undefined) {
    throw new Error(
      `writeRunGroup: two runs would share ${clash.dir}; give each a distinct test id.`,
    );
  }
  fs.mkdirSync(groupDir, { recursive: true });
  for (const child of children) {
    writeRunDirectory(child.run, child.dir);
  }
  return groupDir;
}
