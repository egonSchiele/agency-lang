// The one owner of run loading. Callers see a declarative event stream —
// progress, row upserts, done — and advance the loader one bounded unit
// at a time (one run directory read, one statelog chunk).
//
// A run directory is one `readRunDirectory` (its statelog is the truth,
// so there is nothing left to backfill). A raw statelog file is scanned
// chunk by chunk so a multi-megabyte log cannot starve the keyboard.
import { readRunDirectory } from "@/runDirectory/runDir.js";

import {
  buildFailedRunRow,
  buildRunRowFromDirectory,
  buildTraceRows,
  type RunRow,
} from "./rows.js";
import { createStatelogScan, type StatelogScan } from "./mine.js";
import type { Source } from "./sources.js";

export type LoaderProgress = {
  kind: "progress";
  phase: "summary";
  completed: number;
  total: number;
};

export type LoaderEvent =
  | LoaderProgress
  /** `row` is a snapshot of the loader's live row. */
  | { kind: "upsert"; row: RunRow }
  | { kind: "done"; rows: RunRow[] };

export type RunsLoader = {
  /** Perform one bounded unit of work; returns the events it caused. */
  advance(): LoaderEvent[];
  isDone(): boolean;
};

export function createRunsLoader(sources: Source[]): RunsLoader {
  const pending = [...sources];
  const rows: RunRow[] = [];
  let activeDirectScan: { file: string; scan: StatelogScan } | null = null;
  let announced = false;
  let summaryCompleted = 0;
  let done = false;

  const summaryProgress = (): LoaderProgress => ({
    kind: "progress",
    phase: "summary",
    completed: summaryCompleted,
    total: sources.length,
  });

  const loadRunDir = (dir: string): LoaderEvent[] => {
    const source: Source = { kind: "runDir", dir };
    const warnings: string[] = [];
    let row: RunRow;
    try {
      const snapshot = readRunDirectory(dir, {
        reportWarning: (message) => warnings.push(message),
      });
      row = buildRunRowFromDirectory(snapshot, source);
      row.warnings.push(...warnings);
    } catch (error) {
      // One unreadable directory in two hundred stays visible as a failed
      // row rather than taking the whole table down.
      row = buildFailedRunRow(source, error instanceof Error ? error.message : String(error));
    }
    summaryCompleted += 1;
    rows.push(row);
    return [summaryProgress(), upsertOf(row)];
  };

  const finishDirectScan = (file: string, scan: StatelogScan): LoaderEvent[] => {
    const traceRows = buildTraceRows(file, scan.result());
    rows.push(...traceRows);
    summaryCompleted += 1;
    activeDirectScan = null;
    return [summaryProgress(), ...traceRows.map(upsertOf)];
  };

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
      done = true;
      return [{ kind: "done", rows }];
    },
  };
}

/** Drain a loader synchronously. The only completion path CSV export
 *  uses, so interactive and CSV derivation cannot drift. */
export function loadAllRuns(sources: Source[]): RunRow[] {
  const loader = createRunsLoader(sources);
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
