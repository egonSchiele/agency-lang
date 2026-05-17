// Color-coding thresholds for the logs viewer. Durations above
// `SLOW_MS` and costs above `EXPENSIVE_USD` render bright-red so
// long/expensive operations jump out. Durations under `FAST_MS`
// render gray so the noise fades. Tunable via `agency.json` —
// see `lib/config.ts`.

export type ViewerThresholds = {
  slowMs: number;
  fastMs: number;
  expensiveUsd: number;
};

export const DEFAULT_THRESHOLDS: ViewerThresholds = {
  slowMs: 5000,
  fastMs: 100,
  expensiveUsd: 0.01,
};

export type Magnitude = "fast" | "normal" | "slow" | "cheap" | "expensive";

export function durationMagnitude(
  ms: number,
  t: ViewerThresholds = DEFAULT_THRESHOLDS,
): Magnitude {
  if (ms >= t.slowMs) return "slow";
  if (ms < t.fastMs) return "fast";
  return "normal";
}

export function costMagnitude(
  usd: number,
  t: ViewerThresholds = DEFAULT_THRESHOLDS,
): Magnitude {
  if (usd >= t.expensiveUsd) return "expensive";
  return "cheap";
}
