// Test-only builders for explorer fixtures. Tests get a temp dir and
// call these to lay out run directories and statelogs; nothing here
// ships. Run directories are written the way `eval run` writes them
// (through the run-directory mutations); statelogs the way the runtime
// statelog client emits them (enveloped JSONL events).
import * as fs from "fs";
import * as path from "path";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { recordGradingPass } from "@/runDirectory/mutations.js";

type EnvelopeData = Record<string, unknown> & { type: string };

let fixtureClock = 0;

export function resetFixtureClock(): void {
  fixtureClock = 0;
}

export const FIXTURE_EPOCH_MS = 1_754_000_000_000;

export function envelope(traceId: string, data: EnvelopeData): Record<string, unknown> {
  fixtureClock += 1_000;
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "fixture",
    span_id: null,
    parent_span_id: null,
    data: { timestamp: new Date(FIXTURE_EPOCH_MS + fixtureClock).toISOString(), ...data },
  };
}

export function promptCompletion(
  traceId: string,
  model: string,
  totalCost: number,
): Record<string, unknown> {
  return envelope(traceId, {
    type: "promptCompletion",
    model: `"${model}"`,
    cost: { totalCost, currency: "USD" },
  });
}

export function writeStatelog(filePath: string, events: Record<string, unknown>[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return filePath;
}

/** A graded run directory: two finished traces with input, cost and output,
 *  and one complete grading pass over them. Phase 1 completes the row. */
export function writeGradedRun(baseDir: string, runId: string = "graded-run"): string {
  const runDir = path.join(baseDir, runId);
  const agentLabel = "/abs/path/regex-log.agency:main";
  writeRunDirectory(
    [
      { traceId: "t1", test: { id: "t1", input: "first" }, output: "a", costUsd: 1.25, agentLabel },
      {
        traceId: "t2",
        test: { id: "t2", input: "second" },
        output: "b",
        costUsd: 0.75,
        agentLabel,
      },
    ],
    runDir,
  );
  const grader = { kind: "grader" as const, id: "fixture@1" };
  recordGradingPass({
    dir: runDir,
    scores: [
      {
        traceId: "t1",
        annotator: grader,
        name: "fixture",
        score: { kind: "scalar", value: 1 },
        weight: 1,
        mustPass: false,
      },
      {
        traceId: "t2",
        annotator: grader,
        name: "fixture",
        score: { kind: "binary", pass: false },
        weight: 1,
        mustPass: true,
      },
    ],
  });
  return runDir;
}

/** A killed run: the harness says so; the trace has no output. */
export function writeKilledRun(baseDir: string, runId: string = "killed-run"): string {
  const runDir = path.join(baseDir, runId);
  writeRunDirectory(
    [
      {
        traceId: "k1",
        test: { id: "t1", input: "x" },
        ended: "killed",
        costUsd: 3.0,
        // Command agents record the command line as their label.
        agentLabel: "claude -p {task}",
      },
    ],
    runDir,
  );
  return runDir;
}

/** Two traces in one file; the second names itself via setAgentName. */
export function writeMultiTraceStatelog(
  baseDir: string,
  name: string = "multi-trace.jsonl",
): string {
  return writeStatelog(path.join(baseDir, name), [
    envelope("trace-a", { type: "threadCreated", threadId: "0" }),
    promptCompletion("trace-a", "haiku", 0.05),
    envelope("trace-b", { type: "threadCreated", threadId: "0" }),
    envelope("trace-b", { type: "agentName", name: "named-trace" }),
    promptCompletion("trace-b", "sonnet", 0.4),
  ]);
}
