/*
 * The token usage and cost shapes statelog events log.
 */

// `cachedInputTokens` are tokens READ from an existing cache entry;
// `cacheCreationInputTokens` are tokens WRITTEN to a new one. Providers bill
// them at different rates (a write costs more than ordinary input, a read
// costs far less), so a breakdown that omits either cannot explain its own
// total.
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
};

export type TokenCost = {
  inputCost?: number;
  outputCost?: number;
  cachedInputCost?: number;
  cacheCreationInputCost?: number;
  totalCost?: number;
};

/** Keep only the declared `TokenUsage` fields — drops any extra runtime field a
 *  provider tacks on (e.g. audio-token counters) so it can't be serialized into
 *  a sink through an echoed `completion.usage`. */
export function conformTokenUsage(usage: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: usage.inputTokens as number | undefined,
    outputTokens: usage.outputTokens as number | undefined,
    cachedInputTokens: usage.cachedInputTokens as number | undefined,
    cacheCreationInputTokens: usage.cacheCreationInputTokens as number | undefined,
    totalTokens: usage.totalTokens as number | undefined,
  };
}
