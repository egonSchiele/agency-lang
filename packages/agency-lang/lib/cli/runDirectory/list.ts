import { summarizeRuns, type RunSummary } from "@/runDirectory/list.js";
import { readRunDirectory, type RunDirectorySnapshot } from "@/runDirectory/runDir.js";

import { formatTextTable, oneLine } from "./table.js";

export type RunsListDependencies = { report(message: string): void };

/** One line per trace in a run directory. */
export function runsList(
  dir: string,
  dependencies: RunsListDependencies = { report: (message) => console.log(message) },
): RunSummary[] {
  const snapshot = readRunDirectory(dir, { reportWarning: (message) => console.warn(message) });
  dependencies.report(formatRunsList(snapshot));
  return summarizeRuns(snapshot);
}

export function formatRunsList(snapshot: RunDirectorySnapshot): string {
  const summaries = summarizeRuns(snapshot);
  if (summaries.length === 0) {
    return `${snapshot.dir}: no traces${snapshot.hasStatelog ? "" : " (no statelog.jsonl yet)"}`;
  }
  const header = [
    "TRACE",
    "STARTED",
    "ENDED",
    "TIME",
    "COST",
    "LLM",
    "TOOLS",
    "SCORE",
    "NOTES",
    "LABELED",
    "INPUT",
  ];
  const rows = summaries.map((summary) => [
    summary.traceId.slice(0, 8),
    summary.startedAt === null ? "" : summary.startedAt.slice(0, 16).replace("T", " "),
    summary.ended,
    formatDuration(summary.durationMs),
    `$${summary.costUsd.toFixed(2)}`,
    String(summary.llmCalls),
    String(summary.toolCalls),
    summary.latestScore === null ? "" : summary.latestScore.toFixed(2),
    String(summary.noteCount),
    summary.labeled ? "yes" : "",
    summary.input === null ? "" : oneLine(summary.input, 60),
  ]);
  return formatTextTable(header, rows);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
