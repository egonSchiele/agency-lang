import type { RunSummary } from "agency-lang/eval";

import type { JobResult } from "./runJob.js";

/** One run as `agency runs list --json` prints it. */
export type ListedRun = {
  dir: string;
  summary: RunSummary;
  scores: { name: string; weight: number; mustPass: boolean; feedback?: string }[];
};

export type SummaryRow = {
  label: string;
  result: JobResult | "not started";
  /** The run that came back, when one did. */
  run?: ListedRun;
};

const SCORE_DIGITS = 3;

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0];
}

/** What happened to one job, without its label. */
function outcome(row: SummaryRow): string {
  if (row.result === "not started") {
    return "not started";
  }
  if (!row.result.cameBack) {
    return `failed: ${firstLine(row.result.problem ?? "no run directory came back")}`;
  }
  const score = row.run?.summary.latestScore ?? null;
  const cost = row.run === undefined ? [] : [money(row.run.summary.costUsd)];
  if (row.result.problem !== undefined) {
    const scored = score === null ? [] : [`score ${score.toFixed(SCORE_DIGITS)}`];
    return [firstLine(row.result.problem), ...scored, ...cost].join("  ");
  }
  const graded = score === null ? "not graded" : `score ${score.toFixed(SCORE_DIGITS)}`;
  return [graded, ...cost].join("  ");
}

/** One line per job, labels in a column. */
export function summaryLines(rows: SummaryRow[]): string[] {
  const width = Math.max(0, ...rows.map((row) => row.label.length));
  return rows.map((row) => `${row.label.padEnd(width)}  ${outcome(row)}`);
}
