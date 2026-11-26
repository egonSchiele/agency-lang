import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { foldAnnotations, type Annotation, type EffectiveTraceAnnotations } from "./annotations.js";
import { benchmarkFromSuite } from "./benchmark.js";
import { withFallbackReasoning, type ModelUsage } from "./modelUsage.js";
import type { RunDirectorySnapshot } from "./runDir.js";
import { digestTrace, type TraceDigest } from "./traceDigest.js";

/**
 * The canonical rows one run is made of, wherever they are stored: the
 * trace's events in order (or, for a results-only upload, their digest) and
 * every annotation row about it. Statelog hands its database rows to
 * `summarizeEvalRun` in this shape; a run directory is adapted by
 * `summarizeRunDirectory`. A run that died before its first event has no
 * events and still summarizes: its harness `run` row is the evidence.
 */
export type EvalRunInput = {
  traceId: string;
  annotations: readonly Annotation[];
  /** Diagnostic identity only (a file path, a database id); never read. */
  source: string;
  notes?: string | null;
} & ({ events: readonly EventEnvelope[] } | { digest: TraceDigest });

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
  /** The `run` row's `agentName` when it has one (an importer's
   *  `--agent`), else the trace's own `agentName` event. */
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
  /** The run's LLM usage, one entry per (model, reasoning level) pair,
   *  sorted by name, then reasoning. */
  models: ModelUsage[];
  /** Token totals: the sums over `models`. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  /** The `run` row's `benchmark`, else the suite's folder or file name
   *  (`benchmarkFromSuite`), else null. */
  benchmark: string | null;
  /** The harness's verdict when it recorded one, else read from the trace. */
  ended: string;
  status: RunStatus;
  /** The weighted mean of the effective scores on record; 0 when a
   *  must-pass gate failed; null with none. */
  latestScore: number | null;
  /** What this run counts as in a mean: `latestScore`, except null for a
   *  `void` run and 0 for any other unfinished run with no score. */
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
  const strayRow = input.annotations.find((row) => row.traceId !== input.traceId);
  if (strayRow !== undefined) {
    throw new Error(
      `summarizeEvalRun: run ${input.traceId} was given an annotation of trace ${strayRow.traceId}`,
    );
  }
  return summarizeDigest({
    traceId: input.traceId,
    digest:
      "digest" in input ? input.digest : checkedDigest(input.traceId, input.events, input.source),
    effective: foldAnnotations(input.annotations)[input.traceId],
    hasNotes: hasText(input.notes ?? null),
  });
}

function checkedDigest(
  traceId: string,
  events: readonly EventEnvelope[],
  source: string,
): TraceDigest {
  const strayEvent = events.find((event) => event.trace_id !== traceId);
  if (strayEvent !== undefined) {
    throw new Error(
      `summarizeEvalRun: run ${traceId} was given an event of trace ${strayEvent.trace_id}`,
    );
  }
  return digestTrace({ events, source });
}

/** The run a directory holds: its trace, or, when the run never wrote one,
 *  the run its harness row records. Null for a directory with neither. */
export function summarizeRunDirectory(snapshot: RunDirectorySnapshot): RunSummary | null {
  const hasNotes = hasText(snapshot.notes);
  const [trace] = snapshot.traces;
  if (trace !== undefined) {
    return summarizeDigest({
      traceId: trace.traceId,
      digest: digestTrace({ events: trace.events, source: snapshot.dir }),
      effective: snapshot.effectiveAnnotations[trace.traceId],
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
  return summarizeDigest({
    traceId: silentIds[0],
    digest: digestTrace({ events: [], source: snapshot.dir }),
    effective: snapshot.effectiveAnnotations[silentIds[0]],
    hasNotes,
  });
}

export function summarizeRuns(snapshot: RunDirectorySnapshot): RunSummary[] {
  const summary = summarizeRunDirectory(snapshot);
  return summary === null ? [] : [summary];
}

type RunParts = {
  traceId: string;
  digest: TraceDigest;
  effective: EffectiveTraceAnnotations | undefined;
  hasNotes: boolean;
};

const CUT_SHORT_ENDINGS = ["timeout", "cost-cap", "killed"];

/** Every summary is built here, from the trace's digest and the
 *  annotations, so a stored digest summarizes exactly like its events. */
function summarizeDigest(parts: RunParts): RunSummary {
  const runRow = runRowOf(parts.effective);
  const digest = withReported(parts.digest, runRow);
  const ended = runRow !== null ? runRow.ended : digest.traceEnding;
  const effectiveScore = latestScore(parts.effective);
  const models = withFallbackReasoning(digest.models, runRow?.reasoning ?? null);
  return {
    traceId: parts.traceId,
    testId: testIdOf(runRow),
    input: digest.input,
    agentName: runRow?.agentName ?? digest.agentName,
    agentLabel: agentLabelOf(runRow),
    startedAt: digest.startedAtMs === null ? null : new Date(digest.startedAtMs).toISOString(),
    startedAtMs: digest.startedAtMs,
    endedAt: digest.lastEventAt ?? runRow?.createdAt ?? null,
    durationMs: digest.durationMs,
    // Summed over `models`, not taken from the eval record, so the run's
    // cost is exactly the sum of its entries' costs.
    costUsd: sumOf(models, "costUsd"),
    llmCalls: digest.llmCalls,
    toolCalls: digest.toolCalls,
    eventCount: digest.eventCount,
    models,
    inputTokens: sumOf(models, "inputTokens"),
    cachedInputTokens: sumOf(models, "cachedInputTokens"),
    cacheCreationInputTokens: sumOf(models, "cacheCreationInputTokens"),
    outputTokens: sumOf(models, "outputTokens"),
    benchmark: runRow?.benchmark ?? benchmarkFromSuite(runRow?.suite?.source),
    ended,
    status: statusOf(runRow, digest),
    latestScore: effectiveScore,
    score: scoreOf(ended, effectiveScore),
    gradingPasses: parts.effective?.gradingPasses ?? 0,
    gatesPassed: gatesPassed(parts.effective),
    hasNotes: parts.hasNotes,
    labeled: Object.keys(parts.effective?.checklists ?? {}).length > 0,
    codeHash: digest.codeHash,
    batch: runRow?.batch ?? null,
    trial: runRow?.trial ?? null,
    suiteSource: runRow?.suite?.source ?? null,
    suiteSha: runRow?.suite?.sha ?? null,
  };
}

/** A void run (the sandbox or grader broke) says nothing about the agent;
 *  any other run that didn't end ok scores what it was given, or 0 if it
 *  was never graded. */
function scoreOf(ended: string, effectiveScore: number | null): number | null {
  if (ended === "ok") {
    return effectiveScore;
  }
  if (ended === "void") {
    return null;
  }
  return effectiveScore ?? 0;
}

/** A run with no events takes its usage and times from what the harness
 *  reported, when it reported any. */
function withReported(digest: TraceDigest, runRow: RunRow | null): TraceDigest {
  if (digest.eventCount > 0 || runRow?.reported === undefined) {
    return digest;
  }
  return { ...digest, ...runRow.reported };
}

/** Whether the agent left a record: events, or usage its harness reported. */
export function agentLeftRecord(run: Pick<TraceDigest, "eventCount" | "models">): boolean {
  // With no events, a model entry can only come from the run row's
  // `reported`, which an importer writes with exactly one entry.
  return run.eventCount > 0 || run.models.length > 0;
}

function statusOf(runRow: RunRow | null, digest: TraceDigest): RunStatus {
  if (runRow === null) {
    return "trace";
  }
  if (runRow.ended === "ok") {
    return "ok";
  }
  if (agentLeftRecord(digest) && CUT_SHORT_ENDINGS.includes(runRow.ended)) {
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

type SummedField =
  "inputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "outputTokens" | "costUsd";

function sumOf(models: readonly ModelUsage[], field: SummedField): number {
  return models.reduce((total, item) => total + item[field], 0);
}

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

/** What a listing shows for "which agent": `agentName` (the run row's, else
 *  the trace's own), else the harness label unchanged (a command line is not
 *  shortened: its basename could be any argument), else null. */
export function displayAgent(summary: RunSummary): string | null {
  return summary.agentName ?? summary.agentLabel;
}

/** What `runs list` renders for a set of run directories. */
export type RunsListing = {
  /** One row per run found. */
  summaries: RunSummary[];
  /** Runs where the agent left no record: no events and no reported usage. */
  silentRunCount: number;
  /** summaries.length. */
  runCount: number;
  /** Rows with a persisted score, and their mean; null when none. */
  gradedCount: number;
  meanScore: number | null;
};

/** Takes summaries, not snapshots: a snapshot holds every event of its
 *  trace, so callers summarize each run as they read it (#1559). */
export function buildRunsListing(summaries: RunSummary[]): RunsListing {
  const silentRunCount = summaries.filter(
    (summary) => !agentLeftRecord(summary) && summary.status !== "trace",
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

/** Weighted mean of the effective scores, on 0..1; null when there are none.
 *  A failed must-pass gate makes it 0, as grading scores it (`Scorecard`):
 *  a failed gate stops grading, so the gate may be the only score, and with
 *  weight 0 the mean would otherwise be null and the run look ungraded. */
function latestScore(effective: EffectiveTraceAnnotations | undefined): number | null {
  const rows = Object.values(effective?.scores ?? {});
  if (rows.length === 0) return null;
  if (gatesPassed(effective) === false) return 0;
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
