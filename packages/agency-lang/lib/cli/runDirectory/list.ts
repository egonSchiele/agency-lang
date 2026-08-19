import { findRunDirectories } from "@/runDirectory/findRuns.js";
import {
  buildRunsListing,
  displayAgent,
  type RunsListing,
  type RunSummary,
} from "@/runDirectory/list.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";

import { formatTextTable, oneLine } from "./table.js";

export type RunsListDependencies = { report(message: string): void };

/** One line per run across every run directory the paths name (a run
 *  directory is itself; a directory of run directories is its children). */
export function runsList(
  paths: string[],
  dependencies: RunsListDependencies = { report: (message) => console.log(message) },
): RunSummary[] {
  const snapshots = findRunDirectories(paths).map((dir) =>
    readRunDirectory(dir, { reportWarning: (message) => console.warn(message) }),
  );
  const listing = buildRunsListing(snapshots);
  dependencies.report(formatRunsList(listing));
  return listing.summaries;
}

const HEADER = [
  "TRACE",
  "TEST",
  "AGENT",
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

/** The table (omitted when there are no rows) and the footer line. */
export function formatRunsList(listing: RunsListing): string {
  const footer = footerLine(listing);
  if (listing.summaries.length === 0) {
    return footer;
  }
  const rows = listing.summaries.map((summary) => [
    summary.traceId.slice(0, 8),
    summary.testId ?? "",
    displayAgent(summary) ?? "",
    summary.startedAt === null ? "" : summary.startedAt.slice(0, 16).replace("T", " "),
    summary.ended,
    formatDuration(summary.durationMs),
    `$${summary.costUsd.toFixed(2)}`,
    String(summary.llmCalls),
    String(summary.toolCalls),
    summary.latestScore === null ? "" : summary.latestScore.toFixed(2),
    summary.hasNotes ? "yes" : "",
    summary.labeled ? "yes" : "",
    summary.input === null ? "" : oneLine(summary.input, 60),
  ]);
  return `${formatTextTable(HEADER, rows)}\n${footer}`;
}

/** `N runs · mean 0.720 over G graded · S runs wrote no trace`, clauses present
 *  only when they apply, in that order. */
function footerLine(listing: RunsListing): string {
  return [pluralRuns(listing.runCount), ...meanClause(listing), ...silentRunClause(listing)].join(
    " · ",
  );
}

function meanClause(listing: RunsListing): string[] {
  if (listing.meanScore === null) {
    return [];
  }
  return [`mean ${listing.meanScore.toFixed(3)} over ${listing.gradedCount} graded`];
}

function silentRunClause(listing: RunsListing): string[] {
  if (listing.silentRunCount === 0) {
    return [];
  }
  return [`${pluralRuns(listing.silentRunCount)} wrote no trace`];
}

function pluralRuns(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
