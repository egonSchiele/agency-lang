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
  EvalValue,
  IncompleteInvocation,
  InterruptEntry,
  Metrics,
  NormalizedEvent,
  ThreadEntry,
} from "./types.js";

export type ExtractOptions = {
  /** Max characters for tool argsPreview / outputPreview. Default 200.
   *  Pass 0 for "no truncation". */
  previewChars?: number;
};

type WithWarnings<T> = { result: T; warnings: string[] };

const DEFAULT_PREVIEW_CHARS = 200;
const DEFAULT_EVAL_MAX_VALUE_BYTES = 100_000;
const EVAL_MAX_VALUE_BYTES = parseEvalMaxValueBytes();
const NO_EVAL_INPUT_WARNING =
  "no evalInput() calls in trace; user input inferred from last user-role message of first promptCompletion on the top-level thread. Call evalInput(prompt) in your agent code to record the actual user input.";
const NO_EVAL_OUTPUT_WARNING =
  "no evalOutput() calls in trace; final response inferred from last promptCompletion completion on the top-level thread. Call evalOutput(reply) in your agent code to record the actual user-facing response.";

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
  const evalInputs =
    collectExplicit("evalInputRecorded", n) ?? heuristicInputs(topThreadProms);
  const evalOutputs =
    collectExplicit("evalOutputRecorded", n) ?? heuristicOutputs(topThreadProms);

  const last = n.events[n.events.length - 1];

  return {
    traceId,
    recordVersion: 2,
    formatVersion: events[0].format_version,
    durationMs: last.tMs,
    source,
    evalInputs: capValues(evalInputs.result),
    evalOutputs: capValues(evalOutputs.result),
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
      ...evalInputs.warnings,
      ...evalOutputs.warnings,
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
  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const llms: NormalizedEvent[] = (n.byType.promptCompletion ?? []).map(
    (e) => ({
      kind: "llm" as const,
      tMs: e.tMs,
      threadId: e.threadId,
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      model: modelOf(e.raw),
      tools: toolsOf(e.raw),
      durationMs: numberOrNull(e.raw.data.timeTaken),
      costUsd: cost(e.raw) || null,
      tokensIn: tokensIn(e.raw) || null,
      tokensOut: tokensOut(e.raw) || null,
    }),
  );
  const starts: NormalizedEvent[] = (n.byType.toolCallStart ?? []).map((e) => ({
    kind: "tool_start" as const,
    tMs: e.tMs,
    threadId: e.threadId,
    spanId: e.spanId,
    parentSpanId: e.parentSpanId,
    tool: toolNameOf(e.raw),
    argsPreview: preview(e.raw.data.args, previewChars),
    model: stringOrNull(e.raw.data.model),
  }));
  const ends: NormalizedEvent[] = (n.byType.toolCall ?? []).map((e) => ({
    kind: "tool_end" as const,
    tMs: e.tMs,
    threadId: e.threadId,
    spanId: e.spanId,
    parentSpanId: e.parentSpanId,
    tool: toolNameOf(e.raw),
    outputPreview: preview(e.raw.data.output, previewChars),
    durationMs: numberOrNull(e.raw.data.timeTaken),
  }));
  const merged = [...llms, ...starts, ...ends].sort((a, b) => a.tMs - b.tMs);
  return { result: merged, warnings: [] };
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
): { value: string | null; source: NormalizedEnvelope | null } {
  if (prompts.length === 0) return { value: null, source: null };
  return { value: userMessageOf(prompts[0].raw), source: prompts[0] };
}

function extractFinalResponse(
  prompts: NormalizedEnvelope[],
): { value: string | null; source: NormalizedEnvelope | null } {
  if (prompts.length === 0) return { value: null, source: null };
  const last = prompts[prompts.length - 1];
  return {
    value: completionOf(last.raw),
    source: last,
  };
}

function collectExplicit(
  eventType: string,
  n: Normalized,
): WithWarnings<EvalValue[]> | null {
  const events = n.byType[eventType] ?? [];
  if (events.length === 0) return null;
  return {
    result: events.map((ev) => ({
      value: ev.raw.data.value,
      threadId: ev.threadId,
      tMs: ev.tMs,
    })),
    warnings: [],
  };
}

function heuristicInputs(prompts: NormalizedEnvelope[]): WithWarnings<EvalValue[]> {
  const extracted = extractUserMessage(prompts);
  if (extracted.value === null || extracted.source === null) {
    return { result: [], warnings: [] };
  }
  return {
    result: [
      {
        value: extracted.value,
        threadId: extracted.source.threadId,
        tMs: extracted.source.tMs,
      },
    ],
    warnings: [NO_EVAL_INPUT_WARNING],
  };
}

function heuristicOutputs(prompts: NormalizedEnvelope[]): WithWarnings<EvalValue[]> {
  const extracted = extractFinalResponse(prompts);
  if (extracted.value === null || extracted.source === null) {
    return { result: [], warnings: [] };
  }
  return {
    result: [
      {
        value: extracted.value,
        threadId: extracted.source.threadId,
        tMs: extracted.source.tMs,
      },
    ],
    warnings: [NO_EVAL_OUTPUT_WARNING],
  };
}

function capValues(values: EvalValue[]): EvalValue[] {
  return values.map((entry) => capValue(entry));
}

function capValue(entry: EvalValue): EvalValue {
  const serialized = JSON.stringify(entry.value ?? null);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= EVAL_MAX_VALUE_BYTES) return entry;
  const suffix = `…[truncated ${bytes - EVAL_MAX_VALUE_BYTES} bytes]`;
  const source = typeof entry.value === "string" ? entry.value : serialized;
  return {
    ...entry,
    value: truncateStringForJsonRecord(source, suffix, EVAL_MAX_VALUE_BYTES),
    truncated: true,
  };
}

function truncateStringForJsonRecord(
  source: string,
  suffix: string,
  maxBytes: number,
): string {
  const chars = Array.from(source);
  let lo = 0;
  let hi = chars.length;
  let best = suffix;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join("") + suffix;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function parseEvalMaxValueBytes(): number {
  const parsed = Number(process.env.STATELOG_EVAL_MAX_VALUE_BYTES);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_EVAL_MAX_VALUE_BYTES;
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

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
