// Bounded statelog mining for the loader: per-trace totals for a raw
// statelog file given on the command line. Loader internals, not
// explorer API — views never see this module.
//
// The statelog scan is resumable on purpose: one advance() reads at
// most one chunk, so the shell can interleave scanning a multi-megabyte
// log with keystrokes. The line reader carries a line across chunks.
// Every failure becomes a typed warning, and an unparseable line keeps
// the metrics accumulated before it.
import { emptyTally, tallyEvent, type TurnTally } from "../logsViewer/timeline/turns.js";
import * as fs from "fs";

import { stripQuotes } from "../logsViewer/spanText.js";
import { makeLineReader, READ_CHUNK_BYTES, type LineChunk } from "../statelog/lineReader.js";

/** One advance reads one chunk of the line reader. */
export const STATELOG_SCAN_CHUNK_BYTES = READ_CHUNK_BYTES;

// ── statelog mining ────────────────────────────────────────────────

/** Per-trace totals the accumulator derives. */
export type TraceTotals = {
  costUsd: number;
  models: string[];
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** The trace's turns, so the explorer's duration is working time: a
   *  session that sat between two messages did not take that long. */
  turns: TurnTally;
  agentName?: string;
  eventCount: number;
};

export type ScanResult =
  | { kind: "ok"; traces: Record<string, TraceTotals>; warnings: string[] }
  | { kind: "failed"; warning: string };

export type StatelogScan = {
  /** Read at most one chunk; parse only the complete lines in it.
   *  Returns true when the file is exhausted (or unopenable). */
  advance(): boolean;
  /** Totals accumulated so far — the "is it making progress" window. */
  peekTraces(): Record<string, TraceTotals>;
  /** Terminal result. Only meaningful after advance() returned true. */
  result(): ScanResult;
};

export function createStatelogScan(file: string): StatelogScan {
  const traces: Record<string, TraceTotals> = Object.create(null);
  const warnings: string[] = [];
  const openFailure = unopenableReason(file);
  const reader = makeLineReader(file, 0);
  let done = openFailure !== null;

  const consumeLine = (line: string): void => {
    if (line.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`${file}: unparseable line skipped`);
      return;
    }
    accumulate(traces, parsed);
  };

  return {
    advance(): boolean {
      if (done) {
        return true;
      }
      let chunk: LineChunk;
      try {
        chunk = reader.readChunk();
      } catch (error) {
        warnings.push(`${file}: read failed: ${errText(error)}`);
        done = true;
        return true;
      }
      chunk.lines.forEach(consumeLine);
      if (chunk.atEnd) {
        reader.finish().forEach(consumeLine);
        done = true;
      }
      return done;
    },
    peekTraces(): Record<string, TraceTotals> {
      return traces;
    },
    result(): ScanResult {
      if (openFailure !== null) {
        return { kind: "failed", warning: openFailure };
      }
      // An empty traces object always comes back as "failed" — consumers
      // (loader.jobPatch) rely on "ok" implying at least one trace.
      if (Object.keys(traces).length === 0) {
        return { kind: "failed", warning: `${file}: no recoverable statelog events` };
      }
      return { kind: "ok", traces, warnings };
    },
  };
}

/** Why the file cannot be read, or null when it can. The line reader reads a
 *  missing file as empty, and the scan reports one instead. */
function unopenableReason(file: string): string | null {
  try {
    fs.closeSync(fs.openSync(file, "r"));
    return null;
  } catch (error) {
    return `could not open ${file}: ${errText(error)}`;
  }
}

/** Drive a scan to its terminal result. The synchronous completion path
 *  (CSV export, tests); the interactive shell calls advance() itself. */
export function runScanToEnd(scan: StatelogScan): ScanResult {
  while (!scan.advance()) {
    // one chunk per iteration
  }
  return scan.result();
}

function accumulate(traces: Record<string, TraceTotals>, parsed: unknown): void {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const event = parsed as Record<string, unknown>;
  const traceId = event.trace_id;
  const data = event.data;
  if (typeof traceId !== "string" || typeof data !== "object" || data === null) {
    return;
  }
  const payload = data as Record<string, unknown>;
  const totals = traces[traceId] ?? {
    costUsd: 0,
    models: [],
    firstTsMs: null,
    lastTsMs: null,
    turns: emptyTally(),
    eventCount: 0,
  };
  traces[traceId] = totals;
  totals.eventCount += 1;

  const tsMs = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
  if (Number.isFinite(tsMs)) {
    totals.firstTsMs = totals.firstTsMs === null ? tsMs : Math.min(totals.firstTsMs, tsMs);
    totals.lastTsMs = totals.lastTsMs === null ? tsMs : Math.max(totals.lastTsMs, tsMs);
    tallyEvent(totals.turns, String(payload.type), tsMs, payload.message);
  }

  if (payload.type === "agentName" && typeof payload.name === "string") {
    totals.agentName = payload.name;
  }

  if (payload.type === "promptCompletion") {
    const costRecord = payload.cost as Record<string, unknown> | undefined;
    totals.costUsd += numberOr(costRecord?.totalCost, 0);
    if (typeof payload.model === "string") {
      const model = stripQuotes(payload.model);
      if (!totals.models.includes(model)) {
        totals.models.push(model);
      }
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
