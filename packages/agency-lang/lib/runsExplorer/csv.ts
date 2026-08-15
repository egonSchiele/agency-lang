// CSV export. Interactive `e` exports the current runs-table projection
// (sort/group order preserved; members ALWAYS listed under their group
// header, expanded or not); `--csv` exports the completed, ungrouped
// rows. Both derive from the same RunRow shape, so they cannot drift.
import * as path from "path";

import type { RunRow } from "./rows.js";
import type { TableProjection } from "./views/tableState.js";

export type CsvRow = Record<string, string | number | null>;

export function exportCsv(rows: CsvRow[], now: Date): { path: string; content: string } {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    }
  }
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvField(row[header])).join(","));
  }
  return {
    path: path.resolve(`runs-export-${timestamp(now)}.csv`),
    content: lines.join("\n") + "\n",
  };
}

/** The `--csv` shape: every run, newest first, no grouping. */
export function csvRowsFromRuns(rows: RunRow[]): CsvRow[] {
  const ordered = [...rows].sort(
    (left, right) => (right.startedAtMs ?? 0) - (left.startedAtMs ?? 0),
  );
  return ordered.map(runCsvRow);
}

/** The interactive shape: projection order, group headers as their own
 *  rows, and members listed under their header whether or not the group
 *  is expanded on screen (expanded members are not repeated). */
export function csvRowsFromProjection(projection: TableProjection, allRows: RunRow[]): CsvRow[] {
  const byKey: Record<string, RunRow> = Object.create(null);
  for (const row of allRows) {
    byKey[row.key] = row;
  }
  const out: CsvRow[] = [];
  const emitted: string[] = [];
  for (const display of projection.rows) {
    if (display.kind === "groupHeader") {
      out.push({
        type: "group",
        key: display.key,
        date: null,
        agent: display.aggregates.agent,
        suite: display.aggregates.suite,
        score: display.aggregates.score,
        pass: null,
        status: null,
        costUsd: display.aggregates.cost,
        wallMs: display.aggregates.time,
        models: null,
        count: display.count,
      });
      for (const memberKey of display.memberKeys) {
        const member = byKey[memberKey];
        if (member !== undefined && !emitted.includes(memberKey)) {
          out.push(runCsvRow(member));
          emitted.push(memberKey);
        }
      }
    } else if (!emitted.includes(display.key)) {
      out.push(runCsvRow(display.row));
      emitted.push(display.key);
    }
  }
  return out;
}

function runCsvRow(row: RunRow): CsvRow {
  return {
    type: "run",
    key: row.key,
    date: row.startedAtMs === null ? null : new Date(row.startedAtMs).toISOString(),
    agent: row.agent,
    suite: row.suite,
    score: row.score,
    pass: row.gatesPassed === null ? null : String(row.gatesPassed),
    status: row.status,
    costUsd: row.costUsd,
    wallMs: row.wallMs,
    models: row.models.join("|"),
    count: null,
  };
}

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}
