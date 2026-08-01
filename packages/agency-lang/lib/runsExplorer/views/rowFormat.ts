// Cell formatting shared by the runs and tests tables: the same value
// must read the same way on every screen.
import { costColor, fmtDuration } from "../../logsViewer/spanText.js";
import { DEFAULT_THRESHOLDS } from "../../logsViewer/thresholds.js";
import type { RunRow } from "../rows.js";

export const EMPTY_CELL = "—";
/** Backfill has not filled this cell in yet. */
export const PENDING_CELL = "…";

export function fmtDate(ms: number | null): string {
  if (ms === null) {
    return EMPTY_CELL;
  }
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtScore(score: number | null): string {
  return score === null ? EMPTY_CELL : score.toFixed(2);
}

export function fmtPass(gatesPassed: boolean | null): string {
  if (gatesPassed === null) {
    return EMPTY_CELL;
  }
  return gatesPassed ? "✓" : "✗";
}

export function fmtCost(costUsd: number | null, pending: boolean): string {
  if (costUsd === null) {
    return pending ? PENDING_CELL : EMPTY_CELL;
  }
  return `$${costUsd.toFixed(2)}`;
}

export function fmtTime(ms: number | null, pending: boolean): string {
  if (ms === null) {
    return pending ? PENDING_CELL : EMPTY_CELL;
  }
  return fmtDuration(ms, { minutes: true });
}

export function fmtModels(models: string[]): string {
  return models.join(",");
}

export function scoreColor(score: number | null): string {
  if (score === null) {
    return "gray";
  }
  if (score >= 0.99) {
    return "green";
  }
  if (score <= 0.01) {
    return "bright-red";
  }
  return "yellow";
}

export function passColor(gatesPassed: boolean | null): string {
  if (gatesPassed === null) {
    return "gray";
  }
  return gatesPassed ? "green" : "bright-red";
}

export function statusColor(status: RunRow["status"] | "ok" | "missing" | "failed"): string {
  if (status === "ok") {
    return "green";
  }
  if (status === "partial") {
    return "yellow";
  }
  if (status === "trace" || status === "missing") {
    return "gray";
  }
  return "bright-red";
}

export function costCellColor(costUsd: number | null): string | undefined {
  if (costUsd === null) {
    return "gray";
  }
  return costColor(costUsd, DEFAULT_THRESHOLDS);
}
