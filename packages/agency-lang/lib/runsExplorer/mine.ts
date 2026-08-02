// Bounded artifact mining for the loader: read what a row still needs
// from an eval record or, when records are missing fields or missing
// entirely, from the statelog itself. These are loader internals, not
// explorer API — the loader chooses which miner runs; views never see
// this module.
//
// The statelog scan is resumable on purpose: one advance() reads at
// most one chunk, so the shell can interleave scanning a multi-megabyte
// log with keystrokes. Bytes carry across chunks (a UTF-8 character
// split at a chunk boundary must survive), and every failure becomes a
// typed warning — a torn line keeps the metrics accumulated before it.
import * as fs from "fs";

import { stripQuotes } from "../logsViewer/spanText.js";

export const STATELOG_SCAN_CHUNK_BYTES = 256 * 1024;

// ── record mining ──────────────────────────────────────────────────

/** Null fields mean "this record does not know" — the statelog supplies
 *  them then. A wrong $0.00 would read as a fact, so a record with no
 *  metrics block reports null cost, never zero. */
export type RecordMetrics = {
  costUsd: number | null;
  durationMs: number | null;
  startedAtMs: number | null;
  models: string[] | null;
  agentName?: string;
};

export type RecordMetricsRead =
  | { kind: "metrics"; value: RecordMetrics }
  | { kind: "missing" }
  | { kind: "warning"; message: string };

export function readRecordMetrics(recordPath: string): RecordMetricsRead {
  if (recordPath === "" || !fs.existsSync(recordPath)) {
    return { kind: "missing" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    return { kind: "warning", message: `could not read ${recordPath}: ${errText(error)}` };
  }
  const metrics = parsed.metrics as Record<string, unknown> | undefined;
  const value: RecordMetrics = {
    costUsd: numberOrNull(metrics?.costUsdTotal),
    durationMs: numberOrNull(parsed.durationMs),
    startedAtMs: numberOrNull(parsed.startedAtMs),
    models: Array.isArray(metrics?.models) ? (metrics.models as string[]) : null,
  };
  if (typeof parsed.agentName === "string") {
    value.agentName = parsed.agentName;
  }
  return { kind: "metrics", value };
}

// ── statelog mining ────────────────────────────────────────────────

/** Per-trace totals the accumulator derives. The same accumulation
 *  serves direct statelog rows and backfill, so the two can never
 *  disagree about what a statelog means. */
export type TraceTotals = {
  costUsd: number;
  models: string[];
  firstTsMs: number | null;
  lastTsMs: number | null;
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
  let carry = Buffer.alloc(0);
  let fd: number | null = null;
  let openFailure: string | null = null;
  let done = false;

  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    openFailure = `could not open ${file}: ${errText(error)}`;
    done = true;
  }

  const finish = (): void => {
    done = true;
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
  };

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
      const buf = Buffer.alloc(STATELOG_SCAN_CHUNK_BYTES);
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd as number, buf, 0, buf.length, null);
      } catch (error) {
        warnings.push(`${file}: read failed: ${errText(error)}`);
        finish();
        return true;
      }
      if (bytesRead === 0) {
        if (carry.length > 0) {
          consumeLine(carry.toString("utf8"));
          carry = Buffer.alloc(0);
        }
        finish();
        return true;
      }
      carry = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      let newlineAt: number;
      while ((newlineAt = carry.indexOf(0x0a)) !== -1) {
        consumeLine(carry.subarray(0, newlineAt).toString("utf8"));
        carry = carry.subarray(newlineAt + 1);
      }
      return false;
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
    eventCount: 0,
  };
  traces[traceId] = totals;
  totals.eventCount += 1;

  const tsMs = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
  if (Number.isFinite(tsMs)) {
    totals.firstTsMs = totals.firstTsMs === null ? tsMs : Math.min(totals.firstTsMs, tsMs);
    totals.lastTsMs = totals.lastTsMs === null ? tsMs : Math.max(totals.lastTsMs, tsMs);
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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
