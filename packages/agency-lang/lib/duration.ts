// Parsing human duration strings (`500ms`, `30s`, `5m`, `1h`, `2d`, `1w`) to
// milliseconds. Shared by the `--max-time` flag (lib/cli/budget.ts), the
// `budget.maxTime` config field, and the runtime that installs the time guard —
// so a duration means the same thing everywhere.

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a duration string to milliseconds. Accepts a leading-minus disable
 *  value like `-1s`. A bare unitless number throws: the unit must be explicit so
 *  a value's meaning is never guessed. The result must be finite — an absurdly
 *  long digit string would otherwise overflow to Infinity and silently install
 *  no guard (fail-open on a cost-control feature). `label` names the source in
 *  error messages (e.g. `--max-time` or `budget.maxTime`). */
export function parseDurationMs(s: string, label = "duration"): number {
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(s.trim());
  if (!m) {
    throw new Error(
      `${label}: expected a duration like 500ms, 30s, 5m, 1h, 2d, or 1w (got "${s}")`,
    );
  }
  const ms = parseFloat(m[1]) * UNIT_MS[m[2]];
  if (!Number.isFinite(ms)) {
    throw new Error(`${label}: duration is too large (got "${s}")`);
  }
  return ms;
}
