// A run's LLM usage, one entry per (model, reasoning level) pair, summed
// over its `promptCompletion` events. The run summary carries it, and
// `batchUsage` sums it over a batch, so statelog never sums usage itself.
import {
  byType,
  cost,
  modelOf,
  reasoningEffortOf,
  tokensCached,
  tokensCacheWrite,
  tokensIn,
  tokensOut,
} from "@/statelog/wireAccessors.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import { z } from "zod";

/** The name a call with no model on record is counted under, so a run's
 *  totals still equal the sum of its entries. */
const UNKNOWN_MODEL = "unknown";

export type ModelUsage = {
  name: string;
  /** The requested reasoning level, such as "high": the call's own
   *  `reasoningEffort`, else the run row's `reasoning`, else null (the
   *  provider's default). This is not the model's reasoning text. */
  reasoning: string | null;
  calls: number;
  /** Fresh input; cache reads are `cachedInputTokens`, cache writes
   *  `cacheCreationInputTokens`. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export const ModelUsageSchema = z
  .object({
    name: z.string(),
    reasoning: z.string().nullable(),
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().nonnegative(),
    cachedInputTokens: z.number().nonnegative(),
    cacheCreationInputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().finite(),
  })
  .strict();

/** Sums a run's `promptCompletion` events into entries sorted by name,
 *  then reasoning (null first). A call that recorded no level stays null;
 *  `withFallbackReasoning` fills it from the run row. */
export function modelUsageOf({ events }: { events: readonly EventEnvelope[] }): ModelUsage[] {
  const entries = byType([...events], "promptCompletion").map((event): ModelUsage => ({
    name: modelOf(event) || UNKNOWN_MODEL,
    reasoning: reasoningEffortOf(event) ?? null,
    calls: 1,
    inputTokens: tokensIn(event),
    cachedInputTokens: tokensCached(event),
    cacheCreationInputTokens: tokensCacheWrite(event),
    outputTokens: tokensOut(event),
    costUsd: cost(event),
  }));
  return sumModelUsage([entries]);
}

/** Gives entries with no level the run row's `reasoning` (imported traces
 *  never logged one), merging any that then share a model and level. */
export function withFallbackReasoning(
  models: readonly ModelUsage[],
  fallbackReasoning: string | null,
): ModelUsage[] {
  const filled = models.map((item) =>
    item.reasoning === null ? { ...item, reasoning: fallbackReasoning } : item,
  );
  return sumModelUsage([filled]);
}

/** Merges several lists of entries, summing the ones with the same name
 *  and reasoning level, sorted by name, then reasoning (null first). */
export function sumModelUsage(lists: readonly ModelUsage[][]): ModelUsage[] {
  const sums: Record<string, ModelUsage> = {};
  for (const item of lists.flat()) {
    const key = JSON.stringify([item.name, item.reasoning]);
    const sum = sums[key];
    if (sum === undefined) {
      sums[key] = { ...item };
      continue;
    }
    sum.calls += item.calls;
    sum.inputTokens += item.inputTokens;
    sum.cachedInputTokens += item.cachedInputTokens;
    sum.cacheCreationInputTokens += item.cacheCreationInputTokens;
    sum.outputTokens += item.outputTokens;
    sum.costUsd += item.costUsd;
  }
  return Object.values(sums).toSorted(byNameThenReasoning);
}

function byNameThenReasoning(a: ModelUsage, b: ModelUsage): number {
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  if (a.reasoning === b.reasoning) {
    return 0;
  }
  if (a.reasoning === null) {
    return -1;
  }
  if (b.reasoning === null) {
    return 1;
  }
  return a.reasoning < b.reasoning ? -1 : 1;
}
