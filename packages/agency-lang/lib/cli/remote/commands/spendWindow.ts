// Pure resolution of the `agency remote spend` time flags into a validated
// half-open epoch-ms window plus a human display label. It RETURNS a
// `ResolvedSpendWindow` or THROWS an `Error` — it never calls `fail()` or exits,
// so it is unit-testable without process-exit mocking; `runSpend` converts a
// throw at the command boundary. Every path produces only server-valid bounds
// (non-negative safe integers within Date's representable range).

import { parseDurationMs } from "@/duration.js";
import type { SpendWindow } from "@/cli/statelog/spendTypes.js";

export type SpendWindowOptions = { since?: string; from?: string; to?: string };
export type ResolvedSpendWindow = SpendWindow & { description: string };

const MAX_DATE_TIMESTAMP_MS = 8.64e15;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireInstant(milliseconds: number, label: string): number {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_DATE_TIMESTAMP_MS
  ) {
    throw new Error(`${label} is out of range`);
  }
  return milliseconds;
}

function requireCalendarDate(value: string, label: string): void {
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid date`);
  }
}

function parseInstant(value: string, label: string): number {
  if (/^\d+$/.test(value)) {
    return requireInstant(Number(value), label);
  }
  if (DATE_ONLY.test(value)) {
    requireCalendarDate(value, label);
    return requireInstant(Date.parse(`${value}T00:00:00Z`), label);
  }
  if (DATETIME_WITH_ZONE.test(value)) {
    requireCalendarDate(value.slice(0, 10), label);
    const milliseconds = Date.parse(value);
    if (Number.isNaN(milliseconds)) {
      throw new Error(`${label} is not a valid datetime`);
    }
    return requireInstant(milliseconds, label);
  }
  throw new Error(
    `${label} must be epoch-ms, YYYY-MM-DD, or YYYY-MM-DDTHH:mm[:ss[.sss]] with Z/±HH:mm (got "${value}")`,
  );
}

function describe(from: number | null, to: number | null): string {
  if (from !== null && to !== null) {
    return `from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`;
  }
  if (from !== null) {
    return `from ${new Date(from).toISOString()}`;
  }
  if (to !== null) {
    return `until ${new Date(to).toISOString()}`;
  }
  return "all time";
}

export function resolveSpendWindow(
  options: SpendWindowOptions,
  now: number = Date.now(),
): ResolvedSpendWindow {
  const { since, from, to } = options;
  if (since !== undefined && (from !== undefined || to !== undefined)) {
    throw new Error("--since cannot be combined with --from/--to");
  }
  if (since !== undefined) {
    const normalizedSince = since.trim();
    const durationMs = parseDurationMs(normalizedSince, "--since");
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new Error("--since must be a positive whole-millisecond duration");
    }
    const currentTime = requireInstant(now, "current time");
    return {
      from: requireInstant(currentTime - durationMs, "--since window start"),
      to: currentTime,
      description: `last ${normalizedSince}`,
    };
  }
  const fromMs = from !== undefined ? parseInstant(from, "--from") : null;
  const toMs = to !== undefined ? parseInstant(to, "--to") : null;
  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    throw new Error("--from must be before --to");
  }
  return { from: fromMs, to: toMs, description: describe(fromMs, toMs) };
}
