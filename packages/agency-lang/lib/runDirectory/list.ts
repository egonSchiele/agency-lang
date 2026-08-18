import type { Annotation, EffectiveTraceAnnotations } from "./annotations.js";
import { evalRecordFor, traceEnding } from "./evalRecord.js";
import type { RunDirectorySnapshot } from "./runDir.js";
import type { Trace } from "./traces.js";
import { traceInputText } from "./traceText.js";

/** One row per trace, for `agency runs list` and the viewer's overview. */
export type RunSummary = {
  traceId: string;
  input: string | null;
  startedAt: string | null;
  durationMs: number;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  /** The harness's verdict when it recorded one, else read from the trace. */
  ended: string;
  latestScore: number | null;
  noteCount: number;
  labeled: boolean;
  codeHash: string | null;
};

export function summarizeRuns(snapshot: RunDirectorySnapshot): RunSummary[] {
  return snapshot.traces.map((trace) =>
    summarizeTrace(trace, snapshot.effectiveAnnotations[trace.traceId], snapshot.dir),
  );
}

function summarizeTrace(
  trace: Trace,
  effective: EffectiveTraceAnnotations | undefined,
  sourcePath: string,
): RunSummary {
  const record = evalRecordFor(trace, sourcePath);
  const start = trace.events.find((event) => event.data.type === "agentStart");
  const run = effective?.run;
  return {
    traceId: trace.traceId,
    input: traceInputText(trace, record),
    startedAt: Number.isFinite(record.startedAtMs)
      ? new Date(record.startedAtMs).toISOString()
      : null,
    durationMs: record.durationMs,
    costUsd: record.metrics.costUsdTotal,
    llmCalls: record.metrics.llmCalls,
    toolCalls: record.metrics.toolEnds,
    ended: run !== undefined && run !== null && run.kind === "run" ? run.ended : traceEnding(trace),
    latestScore: latestScore(effective),
    noteCount: effective?.notes.length ?? 0,
    labeled: Object.keys(effective?.checklists ?? {}).length > 0,
    codeHash:
      typeof start?.data.code?.closureHash === "string" ? start.data.code.closureHash : null,
  };
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
