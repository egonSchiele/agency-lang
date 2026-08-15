import { parseDurationMs } from "@/duration.js";

// Re-export so existing `@/cli/budget.js` importers are unaffected by the move
// to the neutral lib/duration.ts (the runtime and builder need the parser too,
// and must not import from lib/cli).
export { parseDurationMs };

/** Resolve --max-cost / --max-time flag strings into the env-var string
 *  values the child reads. Cost stays as dollars; time becomes milliseconds.
 *  Negative/zero pass through — the runtime install applies the disable rule
 *  (cost < 0 disables; time <= 0 disables). */
export function resolveBudget(opts: { maxCost?: string; maxTime?: string }): {
  maxCost?: string;
  maxTime?: string;
} {
  const out: { maxCost?: string; maxTime?: string } = {};
  if (opts.maxCost !== undefined) {
    const n = Number(opts.maxCost);
    if (!Number.isFinite(n)) {
      throw new Error(`--max-cost: expected a number of dollars (got "${opts.maxCost}")`);
    }
    out.maxCost = String(n);
  }
  if (opts.maxTime !== undefined) {
    out.maxTime = String(parseDurationMs(opts.maxTime, "--max-time"));
  }
  return out;
}
