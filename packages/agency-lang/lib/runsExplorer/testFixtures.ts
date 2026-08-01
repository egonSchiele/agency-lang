// Test-only builders for explorer fixtures. Tests get a temp dir and
// call these to lay out run directories and statelogs; nothing here
// ships. The shapes mirror what the eval runner writes (summary.json
// with/without per-input metrics, config.json with provenance) and what
// the runtime statelog client emits (enveloped JSONL events).
import * as fs from "fs";
import * as path from "path";

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

export function promptCompletion(traceId: string, model: string, totalCost: number): Record<string, unknown> {
  return envelope(traceId, {
    type: "promptCompletion",
    model: `"${model}"`,
    cost: { totalCost, currency: "USD" },
  });
}

export function writeStatelog(filePath: string, events: Record<string, unknown>[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return filePath;
}

export type FixtureInput = {
  inputId: string;
  status?: "success" | "error";
  metrics?: {
    costUsd: number;
    durationMs: number;
    startedAtMs: number;
    models: string[];
    agentName?: string;
  };
  /** Written to inputs/<id>/agent/eval-record.json when present. */
  record?: Record<string, unknown>;
  /** Written to inputs/<id>/agent/statelog.jsonl when present. */
  statelogEvents?: Record<string, unknown>[];
};

export type FixtureRun = {
  runId: string;
  agentLabel?: string;
  startedAt?: string;
  inputsSource?: string;
  agentCommand?: string;
  inputs: FixtureInput[];
  grading?: {
    objective: number;
    gatesPassed: boolean;
    perInput: { inputId: string; objective: number; gatesPassed: boolean }[];
  };
};

/** Lay a run directory out exactly as the eval runner does. */
export function writeRunDir(baseDir: string, run: FixtureRun): string {
  const runDir = path.join(baseDir, run.runId);
  fs.mkdirSync(path.join(runDir, "inputs"), { recursive: true });

  const inputs = run.inputs.map((input) => {
    const agentDir = path.join(runDir, "inputs", input.inputId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const recordPath = path.join(agentDir, "eval-record.json");
    const statelogPath = path.join(agentDir, "statelog.jsonl");
    if (input.record !== undefined) {
      fs.writeFileSync(recordPath, JSON.stringify(input.record));
    }
    if (input.statelogEvents !== undefined) {
      writeStatelog(statelogPath, input.statelogEvents);
    }
    const result: Record<string, unknown> = {
      inputId: input.inputId,
      status: input.status ?? "success",
      evalRecordPath: recordPath,
      statelogPath,
      workdirPath: path.join(runDir, "inputs", input.inputId, "workdir"),
    };
    if (input.metrics !== undefined) {
      result.metrics = input.metrics;
    }
    return result;
  });

  const summary: Record<string, unknown> = {
    runId: run.runId,
    runDir,
    agentLabel: run.agentLabel ?? "agent.agency:main",
    inputs,
    okCount: inputs.filter((i) => i.status === "success").length,
    errorCount: inputs.filter((i) => i.status === "error").length,
  };
  if (run.grading !== undefined) {
    summary.grading = { graders: ["fixture"], ...run.grading };
  }
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify({
    runId: run.runId,
    agentLabel: run.agentLabel ?? "agent.agency:main",
    startedAt: run.startedAt ?? new Date(FIXTURE_EPOCH_MS).toISOString(),
    provenance: {
      inputsSource: { source: run.inputsSource ?? "unspecified" },
      files: {},
      agent: run.agentCommand !== undefined
        ? { command: run.agentCommand, harnessVersion: "0.0.0-fixture" }
        : { entry: "agent.agency", closure: [] },
    },
  }, null, 2));

  return runDir;
}

/** A graded modern run: summary carries per-input metrics blocks, so
 *  phase 1 alone completes the row. */
export function writeGradedRun(baseDir: string, runId: string = "graded-run"): string {
  return writeRunDir(baseDir, {
    runId,
    agentLabel: "/abs/path/regex.agency:main",
    startedAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
    inputsSource: "suite/terminal-bench.json",
    inputs: [
      {
        inputId: "t1",
        metrics: { costUsd: 1.25, durationMs: 60_000, startedAtMs: FIXTURE_EPOCH_MS + 1_000, models: ["sonnet"], agentName: "regex-log" },
      },
      {
        inputId: "t2",
        metrics: { costUsd: 0.75, durationMs: 120_000, startedAtMs: FIXTURE_EPOCH_MS + 30_000, models: ["sonnet", "opus"], agentName: "regex-log" },
      },
    ],
    grading: {
      objective: 0.9,
      gatesPassed: true,
      perInput: [
        { inputId: "t1", objective: 1.0, gatesPassed: true },
        { inputId: "t2", objective: 0.8, gatesPassed: false },
      ],
    },
  });
}

/** A run written before the summary carried metrics: records exist on
 *  disk but the summary has no metrics blocks. */
export function writeLegacyRun(baseDir: string, runId: string = "legacy-run"): string {
  return writeRunDir(baseDir, {
    runId,
    inputsSource: "suite/terminal-bench.json",
    inputs: [
      {
        inputId: "t1",
        record: {
          traceId: "legacy-t1",
          recordVersion: 2,
          durationMs: 45_000,
          metrics: { costUsdTotal: 2.5, models: ["opus"] },
        },
        statelogEvents: [
          envelope("legacy-t1", { type: "threadCreated", threadId: "0" }),
          envelope("legacy-t1", { type: "agentName", name: "legacy-agent" }),
          promptCompletion("legacy-t1", "opus", 2.5),
        ],
      },
    ],
    grading: {
      objective: 0.5,
      gatesPassed: false,
      perInput: [{ inputId: "t1", objective: 0.5, gatesPassed: false }],
    },
  });
}

/** A killed run: no record was ever salvaged; the statelog holds the
 *  only truth about cost and models. */
export function writeKilledRun(baseDir: string, runId: string = "killed-run"): string {
  return writeRunDir(baseDir, {
    runId,
    // Command agents record the command string as their label too.
    agentLabel: "claude -p {task}",
    agentCommand: "claude -p {task}",
    inputs: [
      {
        inputId: "t1",
        status: "error",
        statelogEvents: [
          envelope("killed-t1", { type: "threadCreated", threadId: "0" }),
          promptCompletion("killed-t1", "sonnet", 3.0),
          promptCompletion("killed-t1", "sonnet", 3.0),
        ],
      },
    ],
  });
}

/** summary.json cut off mid-write. */
export function writeCorruptRun(baseDir: string, runId: string = "corrupt-run"): string {
  const runDir = path.join(baseDir, runId);
  fs.mkdirSync(path.join(runDir, "inputs"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "summary.json"), '{"runId": "corrupt-run", "inp');
  return runDir;
}

/** Two traces in one file; the second names itself via setAgentName. */
export function writeMultiTraceStatelog(baseDir: string, name: string = "multi-trace.jsonl"): string {
  return writeStatelog(path.join(baseDir, name), [
    envelope("trace-a", { type: "threadCreated", threadId: "0" }),
    promptCompletion("trace-a", "haiku", 0.05),
    envelope("trace-b", { type: "threadCreated", threadId: "0" }),
    envelope("trace-b", { type: "agentName", name: "named-trace" }),
    promptCompletion("trace-b", "sonnet", 0.4),
  ]);
}
