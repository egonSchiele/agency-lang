import { extractEvalRecord } from "@/eval/extract.js";
import type { EvalRecord } from "@/eval/types.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { foldAnnotations, type Annotation, type EffectiveTraceAnnotations } from "./annotations.js";
import { traceEnding } from "./evalRecord.js";
import type { RunDirectorySnapshot } from "./runDir.js";
import { traceInputText } from "./traceText.js";

/**
 * The canonical rows one run is made of, wherever they are stored: the
 * trace's events in order and every annotation row about it. Statelog hands
 * its database rows to `summarizeEvalRun` in this shape; a run directory is
 * adapted by `summarizeRunDirectory`. A run that died before its first event
 * has no events and still summarizes: its harness `run` row is the evidence.
 */
export type EvalRunInput = {
  traceId: string;
  events: readonly EventEnvelope[];
  annotations: readonly Annotation[];
  /** Diagnostic identity only (a file path, a database id); never read. */
  source: string;
  notes?: string | null;
};

/** `ok`: the harness saw a clean finish. `killed`: the harness cut the run
 *  short (timeout, cost cap, signal) after it had produced events. `failed`:
 *  every other harness outcome, including a run with no events at all.
 *  `trace`: no harness row, so only the trace's own ending is known.
 *  `partial` is never produced for one run; aggregates over several runs
 *  (the runs explorer) use it. */
export type RunStatus = "ok" | "partial" | "failed" | "killed" | "trace";

/** One row per run, for `agency runs list`, the viewer's overview, the runs
 *  explorer, batch statistics, and statelog's per-trace summary table. */
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
  /** When the harness recorded the run (its `run` row's `createdAt`), else
   *  the last event's timestamp; null for an empty ad-hoc trace. */
  endedAt: string | null;
  durationMs: number;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  eventCount: number;
  models: string[];
  /** The harness's verdict when it recorded one, else read from the trace. */
  ended: string;
  status: RunStatus;
  /** The weighted mean of the effective scores on record; null with none. */
  latestScore: number | null;
  /** What this run counts as in a mean, by grading's rule (`gradeRun.ts`):
   *  `latestScore` when the run ended ok, 0 when it did not finish (a crash
   *  earns no points, graded or not), null when it ended ok but has no score. */
  score: number | null;
  /** Complete grading passes on this trace; `latestScore` is from the last. */
  gradingPasses: number;
  /** False when an effective must-pass score failed; null with no scores. */
  gatesPassed: boolean | null;
  /** `notes.md` exists and is not blank. */
  hasNotes: boolean;
  labeled: boolean;
  codeHash: string | null;
  /** The suite invocation this run belongs to; null before batches existed. */
  batch: string | null;
  /** The test's 1-based repetition within the batch; null before trials existed. */
  trial: number | null;
  suiteSource: string | null;
  suiteSha: string | null;
};

/** Summarize one run from its canonical rows. Every event and annotation
 *  must belong to `input.traceId`: a mismatch is a caller bug, not data. */
export function summarizeEvalRun(input: EvalRunInput): RunSummary {
  const strayEvent = input.events.find((event) => event.trace_id !== input.traceId);
  if (strayEvent !== undefined) {
    throw new Error(
      `summarizeEvalRun: run ${input.traceId} was given an event of trace ${strayEvent.trace_id}`,
    );
  }
  const strayRow = input.annotations.find((row) => row.traceId !== input.traceId);
  if (strayRow !== undefined) {
    throw new Error(
      `summarizeEvalRun: run ${input.traceId} was given an annotation of trace ${strayRow.traceId}`,
    );
  }
  return summarizeOne({
    traceId: input.traceId,
    events: input.events,
    effective: foldAnnotations(input.annotations)[input.traceId],
    source: input.source,
    hasNotes: hasText(input.notes ?? null),
  });
}

/** The run a directory holds: its trace, or, when the run never wrote one,
 *  the run its harness row records. Null for a directory with neither. */
export function summarizeRunDirectory(snapshot: RunDirectorySnapshot): RunSummary | null {
  const hasNotes = hasText(snapshot.notes);
  const [trace] = snapshot.traces;
  if (trace !== undefined) {
    return summarizeOne({
      traceId: trace.traceId,
      events: trace.events,
      effective: snapshot.effectiveAnnotations[trace.traceId],
      source: snapshot.dir,
      hasNotes,
    });
  }
  const silentIds = Object.keys(snapshot.effectiveAnnotations).filter(
    (traceId) => runRowOf(snapshot.effectiveAnnotations[traceId]) !== null,
  );
  if (silentIds.length === 0) {
    return null;
  }
  if (silentIds.length > 1) {
    throw new Error(
      `${snapshot.dir} records ${silentIds.length} runs (${silentIds.join(", ")}) and no trace; ` +
        `a run directory holds one run.`,
    );
  }
  return summarizeOne({
    traceId: silentIds[0],
    events: [],
    effective: snapshot.effectiveAnnotations[silentIds[0]],
    source: snapshot.dir,
    hasNotes,
  });
}

export function summarizeRuns(snapshot: RunDirectorySnapshot): RunSummary[] {
  const summary = summarizeRunDirectory(snapshot);
  return summary === null ? [] : [summary];
}

type RunParts = {
  traceId: string;
  events: readonly EventEnvelope[];
  effective: EffectiveTraceAnnotations | undefined;
  source: string;
  hasNotes: boolean;
};

const CUT_SHORT_ENDINGS = ["timeout", "cost-cap", "killed"];

function summarizeOne(parts: RunParts): RunSummary {
  const runRow = runRowOf(parts.effective);
  const record: EvalRecord | null =
    parts.events.length === 0 ? null : extractEvalRecord([...parts.events], parts.source);
  const start = parts.events.find((event) => event.data.type === "agentStart");
  const startedAtMs =
    record !== null && Number.isFinite(record.startedAtMs) ? record.startedAtMs : null;
  const lastEvent = parts.events.at(-1);
  const ended = runRow !== null ? runRow.ended : traceEnding({ events: parts.events });
  const effectiveScore = latestScore(parts.effective);
  return {
    traceId: parts.traceId,
    testId: testIdOf(runRow),
    input: record === null ? null : traceInputText({ events: parts.events }, record),
    agentName: record?.agentName ?? null,
    agentLabel: agentLabelOf(runRow),
    startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    startedAtMs,
    endedAt: runRow?.createdAt ?? lastEvent?.data.timestamp ?? null,
    durationMs: record?.durationMs ?? 0,
    costUsd: record?.metrics.costUsdTotal ?? 0,
    llmCalls: record?.metrics.llmCalls ?? 0,
    toolCalls: record?.metrics.toolEnds ?? 0,
    eventCount: parts.events.length,
    models: record === null ? [] : [...record.metrics.models],
    ended,
    status: statusOf(runRow, parts.events.length),
    latestScore: effectiveScore,
    score: ended === "ok" ? effectiveScore : 0,
    gradingPasses: parts.effective?.gradingPasses ?? 0,
    gatesPassed: gatesPassed(parts.effective),
    hasNotes: parts.hasNotes,
    labeled: Object.keys(parts.effective?.checklists ?? {}).length > 0,
    codeHash:
      typeof start?.data.code?.closureHash === "string" ? start.data.code.closureHash : null,
    batch: runRow?.batch ?? null,
    trial: runRow?.trial ?? null,
    suiteSource: runRow?.suite?.source ?? null,
    suiteSha: runRow?.suite?.sha ?? null,
  };
}

function statusOf(runRow: RunRow | null, eventCount: number): RunStatus {
  if (runRow === null) {
    return "trace";
  }
  if (runRow.ended === "ok") {
    return "ok";
  }
  if (eventCount > 0 && CUT_SHORT_ENDINGS.includes(runRow.ended)) {
    return "killed";
  }
  return "failed";
}

function hasText(notes: string | null): boolean {
  return notes !== null && notes.trim().length > 0;
}

/** One short line about a trace's annotations for a listing or the viewer's
 *  trace row: "notes · score 0.70 (3 passes) · labeled". Empty when there are
 *  none; the pass count appears only after a re-grade. */
export function annotationSummaryText(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.hasNotes) parts.push("notes");
  if (summary.latestScore !== null) {
    const passes = summary.gradingPasses > 1 ? ` (${summary.gradingPasses} passes)` : "";
    parts.push(`score ${summary.latestScore.toFixed(2)}${passes}`);
  }
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

type RunRow = Annotation & { kind: "run" };

function runRowOf(effective: EffectiveTraceAnnotations | undefined): RunRow | null {
  const run = effective?.run;
  return run !== undefined && run !== null && run.kind === "run" ? run : null;
}

function agentLabelOf(runRow: RunRow | null): string | null {
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
  /** One row per run found. */
  summaries: RunSummary[];
  /** Runs whose statelog holds no event: the harness recorded a run that died before its first event. */
  silentRunCount: number;
  /** summaries.length. */
  runCount: number;
  /** Rows with a persisted score, and their mean; null when none. */
  gradedCount: number;
  meanScore: number | null;
};

export function buildRunsListing(snapshots: RunDirectorySnapshot[]): RunsListing {
  const summaries = snapshots.flatMap(summarizeRuns);
  const silentRunCount = summaries.filter(
    (summary) => summary.eventCount === 0 && summary.status !== "trace",
  ).length;
  const scores = summaries.flatMap((summary) =>
    summary.latestScore === null ? [] : [summary.latestScore],
  );
  return {
    summaries,
    silentRunCount,
    runCount: summaries.length,
    gradedCount: scores.length,
    meanScore:
      scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
  };
}

function testIdOf(runRow: RunRow | null): string | null {
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
