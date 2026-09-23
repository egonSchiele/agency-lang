// Color-coding thresholds for the logs viewer. Durations above
// `slowMs` and costs above `expensiveUsd` render amber so
// long/expensive operations jump out. Durations under `fastMs`
// render gray so the noise fades. Tunable via `agency.json` —
// see `lib/config/config.ts`.

export type ViewerThresholds = {
  slowMs: number;
  fastMs: number;
  expensiveUsd: number;
};

export const DEFAULT_THRESHOLDS: ViewerThresholds = {
  slowMs: 300000,
  fastMs: 100,
  expensiveUsd: 1,
};

export type Magnitude = "fast" | "normal" | "slow" | "cheap" | "expensive";

export function durationMagnitude(ms: number, t: ViewerThresholds = DEFAULT_THRESHOLDS): Magnitude {
  if (ms >= t.slowMs) return "slow";
  if (ms < t.fastMs) return "fast";
  return "normal";
}

export function costMagnitude(usd: number, t: ViewerThresholds = DEFAULT_THRESHOLDS): Magnitude {
  if (usd >= t.expensiveUsd) return "expensive";
  return "cheap";
}
