// The one owner of run loading and backfill. Callers see a declarative
// event stream — progress, row upserts, done — and advance the loader
// one bounded unit at a time (one summary read, one record read, one
// statelog chunk). Which miner runs, how patches apply, and when a row
// counts as backfilled are decisions that live here and nowhere else.
//
// Phase 1: exactly two content reads per run dir (readEvalRunPhaseOne).
// Phase 2 (backfill), per input that phase 1 could not complete: read
// the eval record first, then stream the statelog only for fields the
// record could not supply (old records lack startedAtMs/agentName;
// killed inputs have no record at all).
import {
  applyInputPatch,
  buildFailedRunRow,
  buildRunRow,
  buildTraceRows,
  recomputeRunAggregates,
  type InputBackfillPatch,
  type RunRow,
} from "./rows.js";
import { readEvalRunPhaseOne, type ReadFileFn } from "./readRunSummary.js";
import {
  createStatelogScan,
  readRecordMetrics,
  type RecordMetrics,
  type StatelogScan,
  type TraceTotals,
} from "./mine.js";
import type { Source } from "./sources.js";

export type LoaderProgress = {
  kind: "progress";
  phase: "summary" | "backfill";
  completed: number;
  total: number;
};

export type LoaderEvent =
  | LoaderProgress
  /** `row` is a snapshot — later backfill mutates the loader's live
   *  row, not an already-emitted event. */
  | { kind: "upsert"; row: RunRow }
  | { kind: "done"; rows: RunRow[] };

export type RunsLoader = {
  /** Perform one bounded unit of work; returns the events it caused. */
  advance(): LoaderEvent[];
  isDone(): boolean;
};

export type LoaderDeps = {
  /** Injectable for read-counting tests. */
  readFile?: ReadFileFn;
};

type BackfillJob = {
  row: RunRow;
  inputId: string;
  recordPath: string;
  statelogPath: string;
  stage: "record" | "scan";
  record: RecordMetrics | null;
  recordWarnings: string[];
  scan: StatelogScan | null;
};

export function createRunsLoader(sources: Source[], deps: LoaderDeps = {}): RunsLoader {
  const pending = [...sources];
  const rows: RunRow[] = [];
  const jobs: BackfillJob[] = [];
  const jobsLeftPerRow: Record<string, number> = Object.create(null);
  let activeDirectScan: { file: string; scan: StatelogScan } | null = null;
  let announced = false;
  let summaryCompleted = 0;
  let backfillCompleted = 0;
  let backfillTotal = 0;
  let done = false;

  const summaryProgress = (): LoaderProgress => ({
    kind: "progress",
    phase: "summary",
    completed: summaryCompleted,
    total: sources.length,
  });
  const backfillProgress = (): LoaderProgress => ({
    kind: "progress",
    phase: "backfill",
    completed: backfillCompleted,
    total: backfillTotal,
  });

  const loadRunDir = (dir: string): LoaderEvent[] => {
    const phaseOne = readEvalRunPhaseOne(dir, deps.readFile);
    summaryCompleted += 1;
    if (phaseOne.kind === "failed") {
      const failed = buildFailedRunRow({ kind: "runDir", dir }, phaseOne.warning);
      rows.push(failed);
      return [summaryProgress(), upsertOf(failed)];
    }
    const built = buildRunRow(phaseOne.value, { kind: "runDir", dir });
    rows.push(built.row);
    const byInputId: Record<string, { recordPath: string; statelogPath: string }> =
      Object.create(null);
    for (const input of phaseOne.value.summary.inputs) {
      byInputId[input.inputId] = {
        recordPath: input.evalRecordPath ?? "",
        statelogPath: input.statelogPath ?? "",
      };
    }
    for (const inputId of built.backfillInputIds) {
      jobs.push({
        row: built.row,
        inputId,
        recordPath: byInputId[inputId]?.recordPath ?? "",
        statelogPath: byInputId[inputId]?.statelogPath ?? "",
        stage: "record",
        record: null,
        recordWarnings: [],
        scan: null,
      });
      backfillTotal += 1;
      jobsLeftPerRow[built.row.key] = (jobsLeftPerRow[built.row.key] ?? 0) + 1;
    }
    return [summaryProgress(), upsertOf(built.row)];
  };

  const finishDirectScan = (file: string, scan: StatelogScan): LoaderEvent[] => {
    const traceRows = buildTraceRows(file, scan.result());
    rows.push(...traceRows);
    summaryCompleted += 1;
    activeDirectScan = null;
    return [summaryProgress(), ...traceRows.map(upsertOf)];
  };

  /** One unit on the current backfill job. Returns events (empty while
   *  the job is still mid-flight). */
  const advanceJob = (job: BackfillJob): LoaderEvent[] => {
    if (job.stage === "record") {
      const read = readRecordMetrics(job.recordPath);
      if (read.kind === "warning") {
        job.recordWarnings.push(read.message);
      }
      if (read.kind === "metrics") {
        job.record = read.value;
        const complete =
          read.value.costUsd !== null &&
          read.value.startedAtMs !== null &&
          read.value.agentName !== undefined;
        if (complete) {
          return finishJob(job);
        }
      }
      job.stage = "scan";
      if (job.statelogPath === "") {
        return finishJob(job);
      }
      job.scan = createStatelogScan(job.statelogPath);
      return [];
    }
    if (job.scan === null || job.scan.advance()) {
      return finishJob(job);
    }
    return [];
  };

  const finishJob = (job: BackfillJob): LoaderEvent[] => {
    applyInputPatch(job.row, job.inputId, jobPatch(job));
    recomputeRunAggregates(job.row);
    backfillCompleted += 1;
    const left = (jobsLeftPerRow[job.row.key] ?? 1) - 1;
    jobsLeftPerRow[job.row.key] = left;
    if (left === 0) {
      job.row.backfilled = true;
    }
    activeJob = null;
    return [backfillProgress(), upsertOf(job.row)];
  };

  let activeJob: BackfillJob | null = null;

  function upsertOf(row: RunRow): LoaderEvent {
    return { kind: "upsert", row: snapshotRow(row) };
  }

  return {
    isDone: () => done,
    advance(): LoaderEvent[] {
      if (done) {
        return [];
      }
      if (!announced) {
        announced = true;
        return [summaryProgress()];
      }
      if (activeDirectScan !== null) {
        if (activeDirectScan.scan.advance()) {
          return finishDirectScan(activeDirectScan.file, activeDirectScan.scan);
        }
        return [];
      }
      const source = pending.shift();
      if (source !== undefined) {
        if (source.kind === "runDir") {
          return loadRunDir(source.dir);
        }
        activeDirectScan = { file: source.file, scan: createStatelogScan(source.file) };
        return [];
      }
      if (activeJob === null) {
        activeJob = jobs.shift() ?? null;
      }
      if (activeJob !== null) {
        return advanceJob(activeJob);
      }
      done = true;
      return [{ kind: "done", rows }];
    },
  };
}

/** Record fields win where both exist (they are the salvaged truth);
 *  the statelog fills what the record could not know. A record with no
 *  metrics block reports null cost/models, so the statelog fallback
 *  runs — a wrong $0.00 must never read as a fact. */
function jobPatch(job: BackfillJob): InputBackfillPatch {
  const patch: InputBackfillPatch = { warnings: [...job.recordWarnings] };
  if (job.record !== null) {
    patch.recordFound = true;
    if (job.record.costUsd !== null) {
      patch.costUsd = job.record.costUsd;
    }
    if (job.record.durationMs !== null) {
      patch.durationMs = job.record.durationMs;
    }
    if (job.record.startedAtMs !== null) {
      patch.startedAtMs = job.record.startedAtMs;
    }
    if (job.record.models !== null) {
      patch.models = job.record.models;
    }
    if (job.record.agentName !== undefined) {
      patch.agentName = job.record.agentName;
    }
  }
  if (job.scan !== null) {
    const result = job.scan.result();
    if (result.kind === "failed") {
      if (job.record === null) {
        patch.warnings.push(result.warning);
      }
      return patch;
    }
    patch.warnings.push(...result.warnings);
    // A per-input row means "this input", not "this trace": an agent
    // that ran agency more than once wrote several traces into one
    // statelog, and dropping all but the first would under-report the
    // very cost this backfill exists to recover. Sum cost, union
    // models, take the envelope of the timestamps.
    const summed = sumTraces(Object.values(result.traces));
    patch.statelogHadEvents = true;
    if (patch.costUsd === undefined) {
      patch.costUsd = summed.costUsd;
    }
    if (patch.models === undefined) {
      patch.models = summed.models;
    }
    if (patch.startedAtMs === undefined && summed.firstTsMs !== null) {
      patch.startedAtMs = summed.firstTsMs;
    }
    if (patch.durationMs === undefined && summed.firstTsMs !== null && summed.lastTsMs !== null) {
      patch.durationMs = summed.lastTsMs - summed.firstTsMs;
    }
    if (patch.agentName === undefined && summed.agentName !== undefined) {
      patch.agentName = summed.agentName;
    }
  }
  return patch;
}

/** Fold every trace of an input's statelog into one total. The agent
 *  name comes from the busiest trace that has one — for an interleaved
 *  log that is the main trace, not whichever id happened to appear
 *  first. */
function sumTraces(traces: TraceTotals[]): TraceTotals {
  const summed: TraceTotals = {
    costUsd: 0,
    models: [],
    firstTsMs: null,
    lastTsMs: null,
    eventCount: 0,
  };
  let namedEventCount = -1;
  for (const totals of traces) {
    summed.costUsd += totals.costUsd;
    summed.eventCount += totals.eventCount;
    for (const model of totals.models) {
      if (!summed.models.includes(model)) {
        summed.models.push(model);
      }
    }
    if (totals.firstTsMs !== null) {
      summed.firstTsMs =
        summed.firstTsMs === null ? totals.firstTsMs : Math.min(summed.firstTsMs, totals.firstTsMs);
    }
    if (totals.lastTsMs !== null) {
      summed.lastTsMs =
        summed.lastTsMs === null ? totals.lastTsMs : Math.max(summed.lastTsMs, totals.lastTsMs);
    }
    if (totals.agentName !== undefined && totals.eventCount > namedEventCount) {
      summed.agentName = totals.agentName;
      namedEventCount = totals.eventCount;
    }
  }
  return summed;
}

/** Drain a loader synchronously. The only completion path CSV export
 *  uses, so interactive and CSV derivation cannot drift. */
export function loadAllRuns(sources: Source[], deps: LoaderDeps = {}): RunRow[] {
  const loader = createRunsLoader(sources, deps);
  let rows: RunRow[] = [];
  while (!loader.isDone()) {
    for (const event of loader.advance()) {
      if (event.kind === "done") {
        rows = event.rows;
      }
    }
  }
  return rows;
}

function snapshotRow(row: RunRow): RunRow {
  return {
    ...row,
    models: [...row.models],
    warnings: [...row.warnings],
    tests: row.tests.map((test) => ({ ...test, models: [...test.models] })),
  };
}
