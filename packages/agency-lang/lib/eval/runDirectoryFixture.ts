import * as fs from "fs";
import * as path from "path";

import type { RunOutcome } from "@/runDirectory/annotations.js";
import { recordCompletedRun } from "@/runDirectory/mutations.js";
import { finishedTraceLines, tempDir } from "@/runDirectory/testFixtures.js";

import type { Test } from "./runTypes.js";

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
};

/**
 * Write a run directory the way `eval run` does — one trace per test, a
 * workdir per trace, and a `run` row per test — for tests of grading, the
 * optimizer, and the CLI. Returns the directory.
 */
export function writeRunDirectory(runs: FakeRun[], dir: string = tempDir("run-")): string {
  fs.mkdirSync(dir, { recursive: true });
  runs.forEach((run, index) => {
    const traceId = run.traceId ?? `trace-${index + 1}`;
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
    let workdir: { traceId: string; sourceDir: string } | undefined;
    if (run.workdirFiles !== undefined && statelogFile !== undefined) {
      const source = path.join(staging, "workdir");
      for (const [rel, text] of Object.entries(run.workdirFiles)) {
        fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
        fs.writeFileSync(path.join(source, rel), text);
      }
      workdir = { traceId, sourceDir: source };
    }
    const ended = run.ended ?? "ok";
    recordCompletedRun({
      dir,
      stagedStatelogFile: statelogFile,
      workdir,
      run: {
        traceId,
        annotator: { kind: "harness", id: "agency-eval@test" },
        payload: {
          kind: "run",
          test: run.test as never,
          suite: null,
          ended,
          flags: run.agentLabel === undefined ? {} : { agent: run.agentLabel },
          ...(ended === "ok" ? {} : { error: run.errorMessage ?? `ended with ${ended}` }),
        },
      },
    });
  });
  return dir;
}
