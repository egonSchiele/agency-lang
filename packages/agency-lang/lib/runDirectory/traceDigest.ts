// The half of a run summary that comes from the trace's events, computed
// once. `agency eval upload --results-only` sends it in place of the events,
// and statelog stores it. A stored digest can't be recomputed (its events
// were never uploaded), so the schema only grows: new fields are optional,
// and every past `version` stays readable.
import { extractEvalRecord } from "@/eval/extract.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import { z } from "zod";

import { TRACE_ENDINGS, traceEnding, type TraceEnding } from "./evalRecord.js";
import { modelUsageOf, ModelUsageSchema, type ModelUsage } from "./modelUsage.js";
import { traceInputText } from "./traceText.js";

export type TraceDigest = {
  version: 1;
  eventCount: number;
  input: string | null;
  agentName: string | null;
  startedAtMs: number | null;
  /** The last event's timestamp: a run's `endedAt` when it has no run row. */
  lastEventAt: string | null;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  /** The trace's own ending: a run's `ended` when it has no run row. */
  traceEnding: TraceEnding;
  codeHash: string | null;
  /** Reasoning stays null where the trace recorded none; the run row's
   *  level is applied when the digest meets the annotations. */
  models: ModelUsage[];
};

export const TraceDigestSchema = z
  .object({
    version: z.literal(1),
    eventCount: z.number().int().nonnegative(),
    input: z.string().nullable(),
    agentName: z.string().nullable(),
    startedAtMs: z.number().finite().nullable(),
    lastEventAt: z.string().nullable(),
    durationMs: z.number().finite(),
    llmCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    traceEnding: z.enum(TRACE_ENDINGS),
    codeHash: z.string().nullable(),
    models: z.array(ModelUsageSchema),
  })
  .strict() satisfies z.ZodType<TraceDigest>;

/** `source` is diagnostic identity only (a file path, a database id). */
export function digestTrace({
  events,
  source,
}: {
  events: readonly EventEnvelope[];
  source: string;
}): TraceDigest {
  const record = events.length === 0 ? null : extractEvalRecord([...events], source);
  const start = events.find((event) => event.data.type === "agentStart");
  const closureHash: unknown = start?.data.code?.closureHash;
  return {
    version: 1,
    eventCount: events.length,
    input: record === null ? null : traceInputText({ events }, record),
    agentName: record?.agentName ?? null,
    startedAtMs: record !== null && Number.isFinite(record.startedAtMs) ? record.startedAtMs : null,
    lastEventAt: events.at(-1)?.data.timestamp ?? null,
    durationMs: record?.durationMs ?? 0,
    llmCalls: record?.metrics.llmCalls ?? 0,
    toolCalls: record?.metrics.toolEnds ?? 0,
    traceEnding: traceEnding({ events }),
    codeHash: typeof closureHash === "string" ? closureHash : null,
    models: modelUsageOf({ events }),
  };
}
