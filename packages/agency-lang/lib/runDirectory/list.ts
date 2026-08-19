import type { Annotation, EffectiveTraceAnnotations } from "./annotations.js";
import { evalRecordFor, traceEnding } from "./evalRecord.js";
import type { RunDirectorySnapshot } from "./runDir.js";
import type { Trace } from "./traces.js";
import { traceInputText } from "./traceText.js";

/** One row per trace, for `agency runs list` and the viewer's overview. */
export type RunSummary = {
  traceId: string;
  /** The test id from the harness's `run` row; null for an ad-hoc trace. */
  testId: string | null;
  input: string | null;
  /** The trace's own `agentName` event, when it emitted one. */
  agentName: string | null;
  /** The harness's agent label from the `run` row (`flags.agent`: an agent
   *  file target or a command line), unchanged; null for an ad-hoc trace. */
  agentLabel: string | null;
  startedAt: string | null;
  startedAtMs: number | null;
  durationMs: number;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  models: string[];
  /** The harness's verdict when it recorded one, else read from the trace. */
  ended: string;
  latestScore: number | null;
  /** False when an effective must-pass score failed; null with no scores. */
  gatesPassed: boolean | null;
  /** `notes.md` exists and is not blank. */
  hasNotes: boolean;
  labeled: boolean;
  codeHash: string | null;
};

export function summarizeRuns(snapshot: RunDirectorySnapshot): RunSummary[] {
  const hasNotes = snapshot.notes !== null && snapshot.notes.trim().length > 0;
  return snapshot.traces.map((trace) =>
    summarizeTrace(trace, snapshot.effectiveAnnotations[trace.traceId], snapshot.dir, hasNotes),
  );
}

function summarizeTrace(
  trace: Trace,
  effective: EffectiveTraceAnnotations | undefined,
  sourcePath: string,
  hasNotes: boolean,
): RunSummary {
  const record = evalRecordFor(trace, sourcePath);
  const start = trace.events.find((event) => event.data.type === "agentStart");
  const run = effective?.run;
  const runRow = run !== undefined && run !== null && run.kind === "run" ? run : null;
  const startedAtMs = Number.isFinite(record.startedAtMs) ? record.startedAtMs : null;
  return {
    traceId: trace.traceId,
    testId: testIdOf(runRow),
    input: traceInputText(trace, record),
    agentName: record.agentName ?? null,
    agentLabel: agentLabelOf(runRow),
    startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    startedAtMs,
    durationMs: record.durationMs,
    costUsd: record.metrics.costUsdTotal,
    llmCalls: record.metrics.llmCalls,
    toolCalls: record.metrics.toolEnds,
    models: [...record.metrics.models],
    ended: runRow !== null ? runRow.ended : traceEnding(trace),
    latestScore: latestScore(effective),
    gatesPassed: gatesPassed(effective),
    hasNotes,
    labeled: Object.keys(effective?.checklists ?? {}).length > 0,
    codeHash:
      typeof start?.data.code?.closureHash === "string" ? start.data.code.closureHash : null,
  };
}

/** One short line about a trace's annotations for a listing or the viewer's
 *  trace row: "notes · score 0.70 · labeled". Empty when there are none. */
export function annotationSummaryText(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.hasNotes) parts.push("notes");
  if (summary.latestScore !== null) parts.push(`score ${summary.latestScore.toFixed(2)}`);
  if (summary.labeled) parts.push("labeled");
  return parts.join(" · ");
}

/** traceId → `annotationSummaryText`, for every trace that has one. */
export function annotationSummaries(snapshot: RunDirectorySnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const summary of summarizeRuns(snapshot)) {
    const text = annotationSummaryText(summary);
    if (text !== "") out[summary.traceId] = text;
  }
  return out;
}

function agentLabelOf(runRow: (Annotation & { kind: "run" }) | null): string | null {
  const label = runRow?.flags.agent;
  if (typeof label !== "string" || label === "") {
    return null;
  }
  return label;
}

/** What a listing shows for "which agent": the trace's own name when it
 *  emitted one, else the harness label unchanged (a command line is not
 *  shortened: its basename could be any argument), else null. */
export function displayAgent(summary: RunSummary): string | null {
  return summary.agentName ?? summary.agentLabel;
}

/** What `runs list` renders for a set of run directories. */
export type RunsListing = {
  /** One row per trace found (a transitional multi-trace directory is several rows). */
  summaries: RunSummary[];
  /** Directories whose statelog holds no trace: a run that died before its first event. */
  silentRunCount: number;
  /** summaries.length + silentRunCount. */
  runCount: number;
  /** Rows with a persisted score, and their mean; null when none. */
  gradedCount: number;
  meanScore: number | null;
};

export function buildRunsListing(snapshots: RunDirectorySnapshot[]): RunsListing {
  const summaries = snapshots.flatMap(summarizeRuns);
  const silentRunCount = snapshots.filter((snapshot) => snapshot.traces.length === 0).length;
  const scores = summaries.flatMap((summary) =>
    summary.latestScore === null ? [] : [summary.latestScore],
  );
  return {
    summaries,
    silentRunCount,
    runCount: summaries.length + silentRunCount,
    gradedCount: scores.length,
    meanScore:
      scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
  };
}

function testIdOf(runRow: (Annotation & { kind: "run" }) | null): string | null {
  const test = runRow?.test;
  if (typeof test !== "object" || test === null || Array.isArray(test)) return null;
  return typeof test.id === "string" ? test.id : null;
}

/** False when an effective must-pass binary score failed, true when every
 *  gate is binary and passed. Null with no scores, and null when any gate is
 *  scalar: a scalar gate's threshold lives on the grader, not the row, so it
 *  cannot be judged here, and "unknown" is more honest than "passed". */
function gatesPassed(effective: EffectiveTraceAnnotations | undefined): boolean | null {
  const gates = Object.values(effective?.scores ?? {}).filter(
    (row) => row.kind === "score" && row.mustPass,
  );
  if (Object.keys(effective?.scores ?? {}).length === 0) return null;
  for (const gate of gates) {
    if (gate.kind !== "score") continue;
    if (gate.score.kind !== "binary") return null;
    if (!gate.score.pass) return false;
  }
  return true;
}

/** Weighted mean of the effective scores, on 0..1; null when there are none. */
function latestScore(effective: EffectiveTraceAnnotations | undefined): number | null {
  const rows = Object.values(effective?.scores ?? {});
  if (rows.length === 0) return null;
  let total = 0;
  let weight = 0;
  for (const row of rows) {
    if (row.kind !== "score") continue;
    total += scoreValue(row) * row.weight;
    weight += row.weight;
  }
  return weight === 0 ? null : total / weight;
}

function scoreValue(row: Annotation & { kind: "score" }): number {
  return row.score.kind === "binary" ? (row.score.pass ? 1 : 0) : row.score.value;
}
