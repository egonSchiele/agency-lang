import type { EventEnvelope } from "../statelog/wireTypes.js";
import {
  completionOf,
  cost,
  modelOf,
  toolNameOf,
  tokensIn,
  tokensOut,
  toolsOf,
  userMessageOf,
} from "../statelog/wireAccessors.js";
import { extractThreads, normalize, type Normalized, type NormalizedEnvelope } from "./normalize.js";
import type {
  ErrorEntry,
  EvalRecord,
  IncompleteInvocation,
  InterruptEntry,
  Metrics,
  NormalizedEvent,
  NormalizedEventBase,
  ThreadEntry,
} from "./types.js";

export type ExtractOptions = {
  /** Max characters for tool argsPreview / outputPreview. Default 200.
   *  Pass 0 for "no truncation". */
  previewChars?: number;
};

type WithWarnings<T> = { result: T; warnings: string[] };

const DEFAULT_PREVIEW_CHARS = 200;

/** Top-level extractor. Composes pure helpers over the Normalized
 *  form produced by `normalize()`; no shared mutable state, no
 *  threading of `t0` through helpers, no direct wire-format reads
 *  outside the accessor layer. */
export function extractEvalRecord(
  events: EventEnvelope[],
  source: string,
  opts: ExtractOptions = {},
): EvalRecord {
  if (events.length === 0) {
    throw new Error("extract: no events in input");
  }

  // Declarative multi-trace check. One pass over `trace_id`, dedupe
  // via Set (used as a one-shot collection, not a stored data
  // structure — per AGENTS.md), throw if more than one trace_id is
  // present.
  const traceIds = [...new Set(events.map((e) => e.trace_id))];
  if (traceIds.length > 1) {
    throw new Error(
      `extract: multiple trace_ids in input (${traceIds.join(", ")}). ` +
        `Exactly one trace per file is supported.`,
    );
  }
  const [traceId] = traceIds;

  const n = normalize(events);
  const threads = extractThreads(n);

  const normalized = normalizeEvents(n, opts);
  const interrupts = extractInterrupts(n);
  const errors = extractErrors(n);
  const incomplete = findIncompleteInvocations(n);
  const metrics = computeMetrics(n);
  const topThreadProms = topLevelPromptCompletions(n, threads);
  const userMessage = extractUserMessage(topThreadProms);
  const finalResponse = extractFinalResponse(topThreadProms);

  const last = n.events[n.events.length - 1];

  return {
    traceId,
    recordVersion: 1,
    formatVersion: events[0].format_version,
    durationMs: last.tMs,
    source,
    userMessage: userMessage.result,
    finalResponse: finalResponse.result,
    threads,
    events: normalized.result,
    interrupts: interrupts.result,
    errors: errors.result,
    incomplete: incomplete.result,
    metrics: metrics.result,
    warnings: [
      ...n.warnings,
      ...normalized.warnings,
      ...interrupts.warnings,
      ...errors.warnings,
      ...incomplete.warnings,
      ...metrics.warnings,
      ...userMessage.warnings,
      ...finalResponse.warnings,
    ],
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers — each is a small declarative composition (filter / map /
// reduce / groupBy). No switching loops over `n.events`.
// ────────────────────────────────────────────────────────────────────

function normalizeEvents(
  n: Normalized,
  opts: ExtractOptions,
): WithWarnings<NormalizedEvent[]> {
  const previewChars = sanitizePreviewChars(opts.previewChars);
  const llms: NormalizedEvent[] = (n.byType.promptCompletion ?? []).map(
    (e) => ({
      ...baseOf(e),
      kind: "llm" as const,
      model: modelOf(e.raw),
      tools: toolsOf(e.raw),
      durationMs: numberOrNull(e.raw.data.timeTaken),
      costUsd: cost(e.raw) || null,
      tokensIn: tokensIn(e.raw) || null,
      tokensOut: tokensOut(e.raw) || null,
    }),
  );
  const starts: NormalizedEvent[] = (n.byType.toolCallStart ?? []).map((e) => ({
    ...baseOf(e),
    kind: "tool_start" as const,
    tool: toolNameOf(e.raw),
    argsPreview: preview(e.raw.data.args, previewChars),
    // Use the same accessor as `llm.model` so any quote-stripping or
    // shape-normalization stays consistent across event kinds.
    model: modelOrNull(e.raw),
  }));
  const ends: NormalizedEvent[] = (n.byType.toolCall ?? []).map((e) => ({
    ...baseOf(e),
    kind: "tool_end" as const,
    tool: toolNameOf(e.raw),
    outputPreview: preview(e.raw.data.output, previewChars),
    durationMs: numberOrNull(e.raw.data.timeTaken),
  }));
  const merged = [...llms, ...starts, ...ends].sort((a, b) => a.tMs - b.tMs);
  return { result: merged, warnings: [] };
}

/** Project the four base fields every NormalizedEvent variant shares
 *  out of a NormalizedEnvelope. One place, not three copies. */
function baseOf(e: NormalizedEnvelope): NormalizedEventBase {
  return {
    tMs: e.tMs,
    threadId: e.threadId,
    spanId: e.spanId,
    parentSpanId: e.parentSpanId,
  };
}

/** Clamp `previewChars` to a finite, non-negative integer. Guards
 *  against `NaN` from `parseInt("foo")` and negative numbers the CLI
 *  might pass through. 0 is allowed (meaning "no truncation"). */
function sanitizePreviewChars(v: number | undefined): number {
  if (v === undefined) return DEFAULT_PREVIEW_CHARS;
  if (!Number.isFinite(v) || v < 0) return DEFAULT_PREVIEW_CHARS;
  return Math.floor(v);
}

function extractInterrupts(n: Normalized): WithWarnings<InterruptEntry[]> {
  const all = [
    ...(n.byType.interruptThrown ?? []),
    ...(n.byType.handlerDecision ?? []),
    ...(n.byType.interruptResolved ?? []),
  ];
  // Group by interruptId. Plain object (per AGENTS.md).
  const groups: Record<string, NormalizedEnvelope[]> = {};
  for (const ev of all) {
    const id = ev.raw.data.interruptId;
    if (typeof id !== "string") continue;
    (groups[id] ??= []).push(ev);
  }
  const result = Object.entries(groups).map(([id, group]) =>
    buildInterruptEntry(id, group),
  );
  return { result, warnings: [] };
}

function buildInterruptEntry(
  interruptId: string,
  group: NormalizedEnvelope[],
): InterruptEntry {
  const sorted = [...group].sort((a, b) => a.tMs - b.tMs);
  const thrown = sorted.find((e) => e.type === "interruptThrown");
  const resolved = sorted.find((e) => e.type === "interruptResolved");
  // `interrupt: {kind, message, data}` summary is attached to
  // handlerDecision / interruptResolved by commit d1d95671. Prefer it,
  // fall back to interruptThrown's `interruptData` for legacy traces.
  const summary =
    sorted.find(
      (e) =>
        (e.type === "handlerDecision" || e.type === "interruptResolved") &&
        e.raw.data.interrupt &&
        typeof e.raw.data.interrupt === "object",
    )?.raw.data.interrupt ?? null;
  const outcomeRaw = resolved?.raw.data.outcome;
  const outcome: InterruptEntry["outcome"] =
    outcomeRaw === "approved" ||
    outcomeRaw === "rejected" ||
    outcomeRaw === "propagated"
      ? outcomeRaw
      : "unresolved";
  const resolvedByRaw = resolved?.raw.data.resolvedBy;
  const resolvedBy: InterruptEntry["resolvedBy"] =
    resolvedByRaw === "handler" ||
    resolvedByRaw === "user" ||
    resolvedByRaw === "policy" ||
    resolvedByRaw === "ipc"
      ? resolvedByRaw
      : null;
  return {
    interruptId,
    kind: summary?.kind ?? null,
    message: summary?.message ?? null,
    data: summary?.data ?? thrown?.raw.data.interruptData ?? null,
    outcome,
    resolvedBy,
    thrownAtMs: thrown?.tMs ?? null,
    resolvedAtMs: resolved?.tMs ?? null,
  };
}

function extractErrors(n: Normalized): WithWarnings<ErrorEntry[]> {
  const result: ErrorEntry[] = (n.byType.error ?? []).map((e) => ({
    tMs: e.tMs,
    errorType: String(e.raw.data.errorType ?? "Error"),
    message: String(e.raw.data.message ?? ""),
    spanId: e.spanId,
  }));
  return { result, warnings: [] };
}

function findIncompleteInvocations(
  n: Normalized,
): WithWarnings<IncompleteInvocation[]> {
  const endedSpans = new Set(
    (n.byType.toolCall ?? []).map((e) => e.spanId).filter((s): s is string => s !== null),
  );
  const result: IncompleteInvocation[] = (n.byType.toolCallStart ?? [])
    .filter((e) => e.spanId === null || !endedSpans.has(e.spanId))
    .map((e) => ({
      tool: toolNameOf(e.raw),
      startedAtMs: e.tMs,
      spanId: e.spanId,
      threadId: e.threadId,
    }));
  return { result, warnings: [] };
}

function computeMetrics(n: Normalized): WithWarnings<Metrics> {
  const proms = n.byType.promptCompletion ?? [];
  const starts = n.byType.toolCallStart ?? [];
  const ends = n.byType.toolCall ?? [];
  const models = [
    ...new Set(proms.map((e) => modelOf(e.raw)).filter((m) => m.length > 0)),
  ].sort();
  const tokensInTotal = proms.reduce((s, e) => s + tokensIn(e.raw), 0);
  const tokensOutTotal = proms.reduce((s, e) => s + tokensOut(e.raw), 0);
  const costUsdTotal = proms.reduce((s, e) => s + cost(e.raw), 0);
  const toolCounts: Record<string, number> = {};
  for (const e of ends) {
    const name = toolNameOf(e.raw);
    if (name.length === 0) continue;
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
  }
  return {
    result: {
      llmCalls: proms.length,
      toolStarts: starts.length,
      toolEnds: ends.length,
      models,
      tokensInTotal,
      tokensOutTotal,
      costUsdTotal,
      toolCounts,
    },
    warnings: [],
  };
}

/** Shared helper: chronologically-ordered promptCompletion events
 *  for the top-level thread. Fallback when no top-level thread is
 *  known (legacy traces, or threads where parentThreadId isn't set
 *  for any entry): return all promptCompletion events in order.
 *  This is the one place the fallback rule lives. */
function topLevelPromptCompletions(
  n: Normalized,
  threads: ThreadEntry[],
): NormalizedEnvelope[] {
  const all = n.byType.promptCompletion ?? [];
  const top = threads.find((t) => t.parentThreadId === null);
  if (top === undefined) return all;
  const onTop = all.filter((e) => e.threadId === top.threadId);
  // If the trace pre-dates Task 0, threadId on prompts is null, so
  // filtering by top.threadId yields nothing. Fall back to all.
  return onTop.length === 0 ? all : onTop;
}

function extractUserMessage(
  prompts: NormalizedEnvelope[],
): WithWarnings<string | null> {
  if (prompts.length === 0) return { result: null, warnings: [] };
  return { result: userMessageOf(prompts[0].raw), warnings: [] };
}

function extractFinalResponse(
  prompts: NormalizedEnvelope[],
): WithWarnings<string | null> {
  if (prompts.length === 0) return { result: null, warnings: [] };
  return {
    result: completionOf(prompts[prompts.length - 1].raw),
    warnings: [],
  };
}

// ────────────────────────────────────────────────────────────────────
// Tiny utilities
// ────────────────────────────────────────────────────────────────────

function preview(value: unknown, limit: number): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (limit === 0) return s;
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + "…";
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Model string via the wire accessor (so quote-stripping etc. stays
 *  centralized), nulled out when empty so `tool_start.model` can be
 *  `string | null` rather than `""`. */
function modelOrNull(ev: EventEnvelope): string | null {
  const m = modelOf(ev);
  return m.length > 0 ? m : null;
}
