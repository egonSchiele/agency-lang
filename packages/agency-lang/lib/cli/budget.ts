const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a duration string (`30s`, `5m`, `1h`, `500ms`, or a leading-minus
 *  disable value like `-1s`) to milliseconds. A bare unitless number throws:
 *  the CLI requires an explicit unit so a value's meaning is never guessed. */
export function parseDurationMs(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(s.trim());
  if (!m) {
    throw new Error(
      `--max-time: expected a duration like 30s, 5m, 1h, or 500ms (got "${s}")`,
    );
  }
  return parseFloat(m[1]) * UNIT_MS[m[2]];
}

/** Resolve --max-cost / --max-time flag strings into the env-var string
 *  values the child reads. Cost stays as dollars; time becomes milliseconds.
 *  Negative/zero pass through — the runtime install applies the disable rule
 *  (cost < 0 disables; time <= 0 disables). */
export function resolveBudget(opts: {
  maxCost?: string;
  maxTime?: string;
}): { maxCost?: string; maxTime?: string } {
  const out: { maxCost?: string; maxTime?: string } = {};
  if (opts.maxCost !== undefined) {
    const n = Number(opts.maxCost);
    if (!Number.isFinite(n)) {
      throw new Error(
        `--max-cost: expected a number of dollars (got "${opts.maxCost}")`,
      );
    }
    out.maxCost = String(n);
  }
  if (opts.maxTime !== undefined) {
    out.maxTime = String(parseDurationMs(opts.maxTime));
  }
  return out;
}
