import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Input } from "@/eval/runTypes.js";

/**
 * A run directory (suite of one) backed by real artifacts on disk, because
 * grading loads the directory: eval-record.json, input.json, summary.json.
 * Optimizer tests inject `runInput` seams that return this directory.
 */
export function fakeRun(inputId: string, output: unknown, spec?: Input): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-run-"));
  const inputDir = path.join(root, "inputs", inputId);
  const workdir = path.join(inputDir, "workdir");
  const agentDir = path.join(inputDir, "agent");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const recordPath = path.join(agentDir, "eval-record.json");
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

  fs.writeFileSync(path.join(inputDir, "input.json"), JSON.stringify({ args: {}, ...spec, id: inputId }));
  fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify({
    runId: "fake",
    runDir: root,
    agentLabel: "fake:main",
    inputs: [{
      inputId,
      status: "success",
      evalRecordPath: recordPath,
      statelogPath: path.join(agentDir, "statelog.jsonl"),
      workdirPath: workdir,
    }],
    okCount: 1,
    errorCount: 0,
  }));
  return root;
}
