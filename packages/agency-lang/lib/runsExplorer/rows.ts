// RunRow: one table row per run (or per statelog trace), plus the pure
// derivation and patch/recompute helpers the loader drives. Nothing
// here does I/O — phase-1 values come in as EvalRunPhaseOne, backfill
// values come in as patches, and every aggregate is recomputed from the
// per-test rows so the two paths cannot disagree.
import type { EvalRunPhaseOne } from "./readRunSummary.js";
import { resolveAgentName } from "./identity.js";
import { suiteFromConfig, UNKNOWN_SUITE } from "./suite.js";
import type { Source } from "./sources.js";
import type { ScanResult, TraceTotals } from "./mine.js";

export type TestRow = {
  inputId: string;
  statelogPath?: string;
  score: number | null;
  gatesPassed: boolean | null;
  status: "ok" | "missing" | "failed";
  costUsd: number | null;
  durationMs: number | null;
  startedAtMs: number | null;
  models: string[];
  /** From the summary metrics block or backfill; feeds run identity. */
  agentName?: string;
  /** Set by backfill: this test's statelog produced events even though
   *  no eval record exists — the signature of a killed run. */
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
  /** summary.json agentLabel, kept for identity fallback + info screen. */
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

export type BuiltRunRow = {
  row: RunRow;
  /** Inputs phase 1 could not complete; the loader schedules one
   *  backfill job per entry. */
  backfillInputIds: string[];
};

export function buildRunRow(phaseOne: EvalRunPhaseOne, source: Source): BuiltRunRow {
  const summary = phaseOne.summary;
  const gradeByInput: Record<string, { objective: number; gatesPassed: boolean }> = Object.create(null);
  for (const grade of summary.grading?.perInput ?? []) {
    const entry = grade as unknown as { inputId: string; objective: number; gatesPassed: boolean };
    gradeByInput[entry.inputId] = entry;
  }

  const backfillInputIds: string[] = [];
  const tests: TestRow[] = summary.inputs.map((input) => {
    const grade = gradeByInput[input.inputId];
    const test: TestRow = {
      inputId: input.inputId,
      statelogPath: input.statelogPath,
      score: grade !== undefined ? grade.objective : null,
      gatesPassed: grade !== undefined ? grade.gatesPassed : null,
      status: initialTestStatus(input),
      costUsd: input.metrics !== undefined ? input.metrics.costUsd : null,
      durationMs: input.metrics !== undefined ? input.metrics.durationMs : null,
      startedAtMs: input.metrics !== undefined ? input.metrics.startedAtMs : null,
      models: input.metrics !== undefined ? [...input.metrics.models] : [],
    };
    if (input.metrics?.agentName !== undefined) {
      test.agentName = input.metrics.agentName;
    }
    // Errored inputs backfill even when a (salvaged, possibly partial)
    // record left metrics behind — their statelog may know more.
    if (input.metrics === undefined || input.status === "error") {
      backfillInputIds.push(input.inputId);
    }
    return test;
  });

  const suite = suiteFromConfig(phaseOne.config);
  const warnings = [...phaseOne.warnings];
  if (suite.warning !== undefined) {
    warnings.push(suite.warning);
  }

  const dir = source.kind === "runDir" ? source.dir : summary.runDir;
  const row: RunRow = {
    key: dir,
    source,
    startedAtMs: parseIsoOrNull(phaseOne.config?.startedAt),
    agent: "",
    agentLabel: summary.agentLabel,
    suite: suite.suite,
    score: typeof summary.grading?.objective === "number" ? summary.grading.objective : null,
    gatesPassed: typeof summary.grading?.gatesPassed === "boolean" ? summary.grading.gatesPassed : null,
    status: "failed",
    costUsd: null,
    wallMs: null,
    models: [],
    tests,
    warnings,
    backfilled: backfillInputIds.length === 0,
  };
  const command = commandFromConfig(phaseOne);
  if (command !== undefined) {
    row.command = command;
  }
  recomputeRunAggregates(row);
  return { row, backfillInputIds };
}

/** A run whose summary could not be read at all: still a row, so 1
 *  corrupt run in 200 stays visible instead of vanishing. */
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

export type InputBackfillPatch = {
  costUsd?: number;
  durationMs?: number;
  startedAtMs?: number;
  models?: string[];
  agentName?: string;
  warnings: string[];
  /** The eval record existed — the test really finished. */
  recordFound?: boolean;
  statelogHadEvents?: boolean;
};

export function applyInputPatch(row: RunRow, inputId: string, patch: InputBackfillPatch): void {
  const test = row.tests.find((candidate) => candidate.inputId === inputId);
  if (test === undefined) {
    row.warnings.push(`backfill for unknown input ${inputId}`);
    return;
  }
  if (patch.costUsd !== undefined) {
    test.costUsd = patch.costUsd;
  }
  if (patch.durationMs !== undefined) {
    test.durationMs = patch.durationMs;
  }
  if (patch.startedAtMs !== undefined) {
    test.startedAtMs = patch.startedAtMs;
  }
  if (patch.models !== undefined) {
    test.models = [...patch.models];
  }
  if (patch.agentName !== undefined) {
    test.agentName = patch.agentName;
  }
  if (patch.statelogHadEvents === true) {
    test.statelogHadEvents = true;
  }
  if (patch.recordFound === true && test.status === "missing") {
    test.status = "ok";
  }
  row.warnings.push(...patch.warnings);
}

/** Recompute every run-level aggregate from the per-test rows. Called
 *  after phase 1 and after every completed backfill patch. */
export function recomputeRunAggregates(row: RunRow): void {
  const tests = row.tests;

  const knownCosts = tests.filter((test) => test.costUsd !== null);
  row.costUsd = knownCosts.length === 0
    ? null
    : knownCosts.reduce((sum, test) => sum + (test.costUsd ?? 0), 0);

  const started = tests.filter((test) => test.startedAtMs !== null);
  if (started.length > 0) {
    const minStart = Math.min(...started.map((test) => test.startedAtMs ?? 0));
    const maxEnd = Math.max(...started.map((test) => (test.startedAtMs ?? 0) + (test.durationMs ?? 0)));
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

/** "missing" = no metrics yet; backfill upgrades it to "ok" when the
 *  eval record turns out to exist. */
function initialTestStatus(input: { status: string; metrics?: unknown }): TestRow["status"] {
  if (input.status === "error") {
    return "failed";
  }
  return input.metrics !== undefined ? "ok" : "missing";
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

function commandFromConfig(phaseOne: EvalRunPhaseOne): string | undefined {
  const agent = phaseOne.config?.provenance?.agent;
  if (agent === undefined) {
    return undefined;
  }
  if ("command" in agent) {
    return agent.command;
  }
  return `agency run ${agent.entry}`;
}

function parseIsoOrNull(iso: string | undefined): number | null {
  if (iso === undefined) {
    return null;
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function lastPathSegment(value: string): string {
  const segments = value.split("/").filter((part) => part !== "");
  return segments[segments.length - 1] ?? value;
}
