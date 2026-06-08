import type { EventEnvelope } from "../statelog/wireTypes.js";
import { threadIdOf, timestampMs } from "../statelog/wireAccessors.js";
import type { ThreadEntry } from "./types.js";

/** Same envelope, with derived fields hoisted onto it so downstream
 *  helpers never re-read raw wire fields. `raw` is preserved verbatim
 *  for the rare helper that needs an obscure field this layer didn't
 *  bother to hoist. */
export type NormalizedEnvelope = {
  raw: EventEnvelope;
  /** ms relative to the first event's timestamp. */
  tMs: number;
  /** Resolved thread id (from `data.threadId` if present, else null). */
  threadId: string | null;
  /** `ev.data.type` hoisted for terser switch/filter. */
  type: string;
  /** `ev.span_id` hoisted. */
  spanId: string | null;
  /** `ev.parent_span_id` hoisted. */
  parentSpanId: string | null;
};

export type Normalized = {
  events: NormalizedEnvelope[];
  /** span_id → normalized envelope, for parent_span_id lookups. */
  spanIndex: Record<string, NormalizedEnvelope>;
  /** Events grouped by `type` (one pass; reused by every helper). */
  byType: Record<string, NormalizedEnvelope[]>;
  /** Warnings produced during normalization. */
  warnings: string[];
};

/** One pass over the raw envelopes that hoists relative timestamps,
 *  resolves thread ids, and builds the span/byType indices. Every
 *  later helper consumes the result; no helper re-reads `data.foo`
 *  for these fields. */
export function normalize(events: EventEnvelope[]): Normalized {
  if (events.length === 0) {
    return { events: [], spanIndex: {}, byType: {}, warnings: [] };
  }
  const t0 = timestampMs(events[0]);
  const normalized: NormalizedEnvelope[] = events.map((raw) => ({
    raw,
    tMs: timestampMs(raw) - t0,
    threadId: threadIdOf(raw),
    type: raw.data.type,
    spanId: raw.span_id,
    parentSpanId: raw.parent_span_id,
  }));

  const spanIndex: Record<string, NormalizedEnvelope> = {};
  for (const ev of normalized) {
    if (ev.spanId !== null) spanIndex[ev.spanId] = ev;
  }

  const byType: Record<string, NormalizedEnvelope[]> = {};
  for (const ev of normalized) {
    (byType[ev.type] ??= []).push(ev);
  }

  const warnings: string[] = [];
  const hasToolOrLlm =
    (byType.promptCompletion?.length ?? 0) +
      (byType.toolCall?.length ?? 0) +
      (byType.toolCallStart?.length ?? 0) >
    0;
  const anyThreadId = normalized.some(
    (e) =>
      (e.type === "promptCompletion" ||
        e.type === "toolCall" ||
        e.type === "toolCallStart") &&
      e.threadId !== null,
  );
  if (hasToolOrLlm && !anyThreadId) {
    warnings.push(
      "no threadId field on tool/LLM events — likely a pre-prereq trace; " +
        "thread attribution will be null for all normalized events",
    );
  }

  return { events: normalized, spanIndex, byType, warnings };
}

/** One entry per `threadCreated` event. `threadResumed` events do
 *  NOT create entries — they map back to the existing thread by id.
 *
 *  This is the one helper that reaches into `ev.raw.data.*` for
 *  thread-specific fields. If a second consumer ever needs them,
 *  promote them into the wire accessor layer. */
export function extractThreads(n: Normalized): ThreadEntry[] {
  const created = n.byType.threadCreated ?? [];
  return created.map((ev) => ({
    threadId: String(ev.raw.data.threadId),
    threadType: ev.raw.data.threadType === "subthread" ? "subthread" : "thread",
    parentThreadId: ev.raw.data.parentThreadId ?? null,
    label: ev.raw.data.label ?? null,
    session: ev.raw.data.session ?? null,
    hidden: Boolean(ev.raw.data.hidden),
    createdAtMs: ev.tMs,
  }));
}
