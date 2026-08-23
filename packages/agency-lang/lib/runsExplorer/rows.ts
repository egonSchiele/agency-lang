// RunRow: one table row per run directory (or per statelog trace), plus
// the pure derivation helpers the loader drives. Nothing here does I/O —
// a run directory comes in as the snapshot `readRunDirectory` produced,
// a raw statelog as the miner's scan result, and every aggregate is
// recomputed from the per-test rows so no two paths can disagree.
import * as path from "path";

import { summarizeRuns } from "@/runDirectory/list.js";
import type { RunDirectorySnapshot } from "@/runDirectory/runDir.js";
import { runDirPaths } from "@/runDirectory/runDir.js";

import { resolveAgentName } from "./identity.js";
import { suiteFromSource, UNKNOWN_SUITE } from "./suite.js";
import type { Source } from "./sources.js";
import type { ScanResult, TraceTotals } from "./mine.js";

export type TestRow = {
  inputId: string;
  /** The trace this test ran as; the viewer opens the run's statelog on it. */
  traceId?: string;
  statelogPath?: string;
  score: number | null;
  gatesPassed: boolean | null;
  status: "ok" | "missing" | "failed";
  costUsd: number | null;
  durationMs: number | null;
  startedAtMs: number | null;
  models: string[];
  /** The trace's `agentName` event; feeds run identity. */
  agentName?: string;
  /** The trace produced events but the run was cut short (timeout, cost
   *  cap, kill) — the signature of a killed run. */
  statelogHadEvents?: boolean;
};

export type RunRow = {
  /** Stable identity: the run directory, or `${statelogPath}#${traceId}`.
   *  The cursor pins to this, never to a table index. */
  key: string;
  source: Source;
  startedAtMs: number | null;
  agent: string;
  /** Shown on the info screen only; the table shows `agent`. */
  command?: string;
  /** The harness's agent label (`flags.agent` on the run row), kept for
   *  identity fallback + info screen. */
  agentLabel?: string;
  suite: string;
  score: number | null;
  gatesPassed: boolean | null;
  status: "ok" | "partial" | "failed" | "killed" | "trace";
  costUsd: number | null;
  wallMs: number | null;
  models: string[];
  tests: TestRow[];
  warnings: string[];
  backfilled: boolean;
};

const CUT_SHORT_ENDINGS = ["timeout", "cost-cap", "killed", "unknown"];

/**
 * One row for a run directory, from its summary. The run is a test row
 * whether or not it wrote a trace: the harness `run` row names the test and
 * how it ended; scores come from the effective annotations; cost, time and
 * models from the trace (zero for a run that died before its first event).
 */
export function buildRunRowFromDirectory(snapshot: RunDirectorySnapshot, source: Source): RunRow {
  const summaries = summarizeRuns(snapshot);
  const statelogPath = runDirPaths(snapshot.dir).statelog;
  const tests: TestRow[] = summaries.map((summary) => {
    const test: TestRow = {
      inputId: summary.testId ?? summary.traceId,
      traceId: summary.traceId,
      statelogPath,
      score: summary.latestScore,
      gatesPassed: summary.gatesPassed,
      status: summary.ended === "ok" ? "ok" : "failed",
      costUsd: summary.costUsd,
      durationMs: summary.durationMs,
      startedAtMs: summary.startedAtMs,
      models: summary.models,
    };
    // A run the harness cut short (timeout, cost cap, kill) is the explorer's
    // "killed": events exist, but nothing finished. An error is a plain failure.
    if (summary.eventCount > 0 && CUT_SHORT_ENDINGS.includes(summary.ended)) {
      test.statelogHadEvents = true;
    }
    if (summary.agentName !== null) {
      test.agentName = summary.agentName;
    }
    return test;
  });

  const row: RunRow = {
    key: snapshot.dir,
    source,
    startedAtMs: null,
    agent: "",
    suite: suiteFromSource(summaries[0]?.suiteSource),
    score: meanScore(tests),
    gatesPassed: runGatesPassed(tests),
    status: "failed",
    costUsd: null,
    wallMs: null,
    models: [],
    tests,
    warnings: [],
    backfilled: true,
  };
  const agentLabel = summaries[0]?.agentLabel;
  if (typeof agentLabel === "string") {
    row.agentLabel = agentLabel;
  }
  recomputeRunAggregates(row);
  return row;
}

/** False if any test failed a gate, true if any passed and none failed,
 *  null when no test has a verdict. */
function runGatesPassed(tests: TestRow[]): boolean | null {
  if (tests.some((test) => test.gatesPassed === false)) return false;
  if (tests.some((test) => test.gatesPassed === true)) return true;
  return null;
}

/** Mean of the tests that have a score; null when none do. */
function meanScore(tests: TestRow[]): number | null {
  const scored = tests.filter((test) => test.score !== null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, test) => sum + (test.score ?? 0), 0) / scored.length;
}

/** A source that could not be read at all: still a row, so 1 broken run
 *  in 200 stays visible instead of vanishing. */
export function buildFailedRunRow(source: Source, warning: string): RunRow {
  const key = source.kind === "runDir" ? source.dir : source.file;
  return {
    key,
    source,
    startedAtMs: null,
    agent: lastPathSegment(key),
    suite: UNKNOWN_SUITE,
    score: null,
    gatesPassed: null,
    status: "failed",
    costUsd: null,
    wallMs: null,
    models: [],
    tests: [],
    warnings: [warning],
    backfilled: true,
  };
}

/** One row per recovered trace of a raw statelog file. */
export function buildTraceRows(file: string, result: ScanResult): RunRow[] {
  if (result.kind === "failed") {
    return [buildFailedRunRow({ kind: "statelog", file }, result.warning)];
  }
  return Object.entries(result.traces).map(([traceId, totals]) => ({
    key: `${file}#${traceId}`,
    source: { kind: "statelog", file } as Source,
    startedAtMs: totals.firstTsMs,
    agent: resolveAgentName({
      agentName: totals.agentName,
      fallback: `${lastPathSegment(file)}#${traceId.slice(0, 6)}`,
    }),
    suite: UNKNOWN_SUITE,
    score: null,
    gatesPassed: null,
    status: "trace" as const,
    costUsd: totals.costUsd,
    wallMs: traceWallMs(totals),
    models: [...totals.models],
    tests: [],
    warnings: [...result.warnings],
    backfilled: true,
  }));
}

/** Recompute every run-level aggregate from the per-test rows. Called
 *  after phase 1 and after every completed backfill patch. */
export function recomputeRunAggregates(row: RunRow): void {
  const tests = row.tests;

  const knownCosts = tests.filter((test) => test.costUsd !== null);
  row.costUsd =
    knownCosts.length === 0 ? null : knownCosts.reduce((sum, test) => sum + (test.costUsd ?? 0), 0);

  const started = tests.filter((test) => test.startedAtMs !== null);
  if (started.length > 0) {
    const minStart = Math.min(...started.map((test) => test.startedAtMs ?? 0));
    const maxEnd = Math.max(
      ...started.map((test) => (test.startedAtMs ?? 0) + (test.durationMs ?? 0)),
    );
    row.startedAtMs = minStart;
    row.wallMs = maxEnd - minStart;
  }

  const models: string[] = [];
  for (const test of tests) {
    for (const model of test.models) {
      if (!models.includes(model)) {
        models.push(model);
      }
    }
  }
  row.models = models;

  row.agent = resolveAgentName({
    agentName: tests.map((test) => test.agentName).find((name) => name !== undefined),
    agentLabel: row.agentLabel,
    command: row.command,
    fallback: lastPathSegment(row.key),
  });

  row.status = deriveRunStatus(tests);
}

function deriveRunStatus(tests: TestRow[]): RunRow["status"] {
  if (tests.length === 0) {
    return "failed";
  }
  const okCount = tests.filter((test) => test.status === "ok").length;
  if (okCount === tests.length) {
    return "ok";
  }
  if (okCount > 0) {
    return "partial";
  }
  if (tests.some((test) => test.statelogHadEvents === true)) {
    return "killed";
  }
  return "failed";
}

function traceWallMs(totals: TraceTotals): number | null {
  if (totals.firstTsMs === null || totals.lastTsMs === null) {
    return null;
  }
  return totals.lastTsMs - totals.firstTsMs;
}

function lastPathSegment(value: string): string {
  return path.basename(value) || value;
}
