import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { EvalRunInputResult } from "@/eval/runTypes.js";

/**
 * An `EvalRunInputResult` backed by a real eval record on disk, because grading
 * reads that file. Optimizer tests inject `runInput` seams that used to return
 * `{ output, recordPath }` directly; now they return this.
 */
export function fakeRun(inputId: string, output: unknown, dir?: string): EvalRunInputResult {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "optimize-run-"));
  const inputDir = path.join(root, inputId);
  const workdir = path.join(inputDir, "workdir");
  fs.mkdirSync(workdir, { recursive: true });

  const recordPath = path.join(inputDir, "eval-record.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    traceId: "t",
    recordVersion: 2,
    formatVersion: 1,
    durationMs: 1,
    source: "test",
    evalValues: [],
    evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
    threads: [],
    events: [],
    interrupts: [],
    errors: [],
    incomplete: [],
    metrics: {
      llmCalls: 0, toolStarts: 0, toolEnds: 0, models: [],
      tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0, toolCounts: {},
    },
    warnings: [],
  }));

  return {
    inputId,
    status: "success",
    evalRecordPath: recordPath,
    statelogPath: path.join(inputDir, "statelog.jsonl"),
    workdirPath: workdir,
  };
}
