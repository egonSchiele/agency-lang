// The token totals the REPL's footer compares before and after a turn: read
// from the REPL's own run, or from a callback a caller gave `repl()` when
// its turns run in another run, as `agency agent`'s do.
import { __call } from "../runtime/call.js";
import type { Run } from "../runtime/asyncContext.js";
import { normalizeModelUsage } from "../runtime/utils.js";

/** Cumulative per-model token+cost totals, keyed by model name. */
export type ModelTotals = Record<string, { tokens: number; cost: number }>;

export type TokenSnapshot = {
  inputTokens: number;
  outputTokens: number;
  models: ModelTotals;
};

const NO_TOKENS: TokenSnapshot = { inputTokens: 0, outputTokens: 0, models: {} };

/** Read the cumulative input/output token counts (and per-model
 *  breakdown) from the REPL's RuntimeContext's GlobalStore. Returns
 *  zeros when the token-stats slot is missing (defensive — a test's
 *  context sometimes has none). */
function readTokenSnapshot(ctx: Run["ctx"]): TokenSnapshot {
  try {
    const stats = ctx?.globals?.getTokenStats?.();
    if (!stats || typeof stats !== "object") return NO_TOKENS;
    // Per-model breakdown (updateTokenStats). Snapshotted so the footer
    // can diff before/after and list the models used *this turn*. Shares
    // the defensive field-narrowing in `normalizeModelUsage`.
    const models: ModelTotals = {};
    for (const m of normalizeModelUsage((stats as { models?: unknown }).models)) {
      models[m.model] = {
        tokens: m.inputTokens + m.outputTokens + m.cachedInputTokens + m.cacheCreationInputTokens,
        cost: m.cost,
      };
    }
    const usage = (stats as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") {
      return { inputTokens: 0, outputTokens: 0, models };
    }
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      // The footer's `↑` is "how much went up the wire this turn", so cache
      // reads and writes belong in it: both are input the provider billed
      // for. Counting only uncached input reports a small fraction of a
      // cached conversation — on a long agent turn, a few percent of it.
      inputTokens:
        num(usage.inputTokens) + num(usage.cachedInputTokens) + num(usage.cacheCreationInputTokens),
      outputTokens: num(usage.outputTokens),
      models,
    };
  } catch {
    return NO_TOKENS;
  }
}

/** The footer's token totals now: from `tokens`, the callback a caller
 *  gave `repl()` because its turns run in another run, or from the REPL's
 *  own run when there is none. Zeros when the callback fails or returns
 *  something else, so the footer never breaks a turn. The callback is an
 *  Agency function, so it is called the way the REPL calls `status`. */
export async function tokenSnapshot(run: Run, tokens: unknown): Promise<TokenSnapshot> {
  if (tokens == null) {
    return readTokenSnapshot(run.ctx);
  }
  try {
    return snapshotFrom(await __call(run, tokens, { type: "positional", args: [] }));
  } catch {
    return NO_TOKENS;
  }
}

function numberOr0(field: unknown): number {
  return typeof field === "number" ? field : 0;
}

function modelTotalsFrom(given: unknown): ModelTotals {
  const models: ModelTotals = {};
  if (typeof given !== "object" || given === null) {
    return models;
  }
  for (const [name, totals] of Object.entries(given)) {
    const entry = typeof totals === "object" && totals !== null ? totals : {};
    models[name] = {
      tokens: numberOr0("tokens" in entry ? entry.tokens : 0),
      cost: numberOr0("cost" in entry ? entry.cost : 0),
    };
  }
  return models;
}

/** A snapshot from what a `tokens` callback returned: fields that are not
 *  numbers count as zero. */
function snapshotFrom(value: unknown): TokenSnapshot {
  const record = typeof value === "object" && value !== null ? value : {};
  return {
    inputTokens: numberOr0("inputTokens" in record ? record.inputTokens : 0),
    outputTokens: numberOr0("outputTokens" in record ? record.outputTokens : 0),
    models: modelTotalsFrom("models" in record ? record.models : null),
  };
}
