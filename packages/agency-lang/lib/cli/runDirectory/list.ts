import * as path from "path";

import { findRunDirectories } from "@/runDirectory/findRuns.js";
import {
  buildRunsListing,
  displayAgent,
  summarizeRuns,
  type RunsListing,
  type RunSummary,
} from "@/runDirectory/list.js";
import type { Annotation, Score } from "@/runDirectory/annotations.js";
import { readRunDirectory, type RunDirectorySnapshot } from "@/runDirectory/runDir.js";

import { formatTextTable, oneLine } from "@/runDirectory/table.js";

export type RunsListDependencies = { report(message: string): void };

/** One run as `runs list --json` prints it: where it is, its summary, and
 *  the scores that currently count for it, one per grader. For a program
 *  that needs a run's results without reading the run directory itself. */
export type ListedRun = {
  dir: string;
  summary: RunSummary;
  scores: ListedScore[];
};

export type ListedScore = {
  name: string;
  score: Score;
  weight: number;
  mustPass: boolean;
  feedback?: string;
};

/** One line per run across every run directory the paths name (a run
 *  directory is itself; a directory of run directories is its children). */
export function runsList(
  paths: string[],
  dependencies: RunsListDependencies = { report: (message) => console.log(message) },
  options: { json?: boolean } = {},
): RunSummary[] {
  // One run at a time: each snapshot is dropped once summarized, so memory
  // stays flat however many runs are listed.
  const listed = findRunDirectories(paths).flatMap((dir) =>
    listedRuns(readRunDirectory(dir, { reportWarning: (message) => console.warn(message) })),
  );
  const listing = buildRunsListing(listed.map((run) => run.summary));
  dependencies.report(options.json === true ? JSON.stringify(listed) : formatRunsList(listing));
  return listing.summaries;
}

function listedRuns(snapshot: RunDirectorySnapshot): ListedRun[] {
  return summarizeRuns(snapshot).map((summary) => ({
    dir: snapshot.dir,
    summary,
    scores: Object.values(snapshot.effectiveAnnotations[summary.traceId]?.scores ?? {}).flatMap(
      listedScore,
    ),
  }));
}

function listedScore(row: Annotation): ListedScore[] {
  if (row.kind !== "score") {
    return [];
  }
  return [
    {
      name: row.name,
      score: row.score,
      weight: row.weight,
      mustPass: row.mustPass,
      ...(row.feedback === undefined ? {} : { feedback: row.feedback }),
    },
  ];
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
  "PASSES",
  "NOTES",
  "LABELED",
  "INPUT",
];

/** The table (omitted when there are no rows) and the footer line. Agent
 *  file paths under `cwd` are shown relative to it. */
export function formatRunsList(listing: RunsListing, cwd: string = process.cwd()): string {
  const footer = footerLine(listing);
  if (listing.summaries.length === 0) {
    return footer;
  }
  const rows = listing.summaries.map((summary) => [
    summary.traceId.slice(0, 8),
    summary.testId ?? "",
    relativeAgentLabel(displayAgent(summary) ?? "", cwd),
    summary.startedAt === null ? "" : summary.startedAt.slice(0, 16).replace("T", " "),
    summary.ended,
    formatDuration(summary.durationMs),
    `$${summary.costUsd.toFixed(2)}`,
    String(summary.llmCalls),
    String(summary.toolCalls),
    summary.latestScore === null ? "" : summary.latestScore.toFixed(2),
    summary.gradingPasses === 0 ? "" : String(summary.gradingPasses),
    summary.hasNotes ? "yes" : "",
    summary.labeled ? "yes" : "",
    summary.input === null ? "" : oneLine(summary.input, 60),
  ]);
  return `${formatTextTable(HEADER, rows)}\n${footer}`;
}

/** `/home/me/proj/test.agency:main` reads `test.agency:main` when run from
 *  `/home/me/proj`. Labels outside `cwd`, and command lines, are unchanged. */
export function relativeAgentLabel(label: string, cwd: string): string {
  const match = label.match(/^(\S+\.agency)(:\S+)?$/);
  if (match === null || !path.isAbsolute(match[1])) return label;
  const relative = path.relative(cwd, match[1]);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return label;
  return relative + (match[2] ?? "");
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
