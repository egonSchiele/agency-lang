/**
 * Performance-test harness. The "how" of measuring, so the perf tests state only
 * the "what" ("does lint scale under the growth bound?").
 *
 * Why a custom harness and not vitest's `bench` (tinybench): `bench` is
 * mean-based and comparison-shaped, and gives no clean seam for a normalized
 * growth-factor assertion or the informational-vs-gating `PERF_ENFORCE` gate.
 * Both of those are the point here, so we own the loop.
 *
 * The core idea (see docs/superpowers/specs/2026-07-24-ci-performance-tests-design.md):
 * assert how work GROWS with input size, not absolute milliseconds. A ratio of
 * two measurements from the same run cancels steady-state machine speed, which
 * is what makes it robust on a noisy CI runner. `growthFactor` normalizes that
 * ratio by the size step so a perfectly linear algorithm reads 1.0 regardless of
 * the step, and a quadratic reads ~step.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Normalized growth bound: 1.0 = perfectly linear. Above this trips the check.
 *  Start loose and tighten from the informational data; a quadratic reads ~8 at
 *  an 8x step, so 2.0 leaves generous room above linear while catching genuine
 *  super-linear growth. */
export const GROWTH_BOUND = 2.0;
export const WARMUP = 2;
export const RUNS = 7;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A sink the timed closures write into, so V8 cannot dead-code-eliminate the
// work under measurement when its result would otherwise be unused.
let sink: unknown;

function timeOnce(fn: () => unknown): number {
  const start = performance.now();
  sink = fn();
  return performance.now() - start;
}

/** Median elapsed ms over `runs` timed calls after `warmup` untimed ones. For
 *  the Layer-2 absolute smoke checks (a single closure, no ratio). Not used
 *  inside `growthFactor` — nesting a median there would make one size's runs
 *  contiguous again and defeat the interleave. */
export function measureMs(
  fn: () => unknown,
  opts: { warmup?: number; runs?: number } = {},
): number {
  const warmup = opts.warmup ?? WARMUP;
  const runs = opts.runs ?? RUNS;
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) times.push(timeOnce(fn));
  return median(times);
}

/**
 * The normalized growth number: 1.0 = linear, `large/small` (the step) =
 * quadratic. `build(n)` does all untimed setup and returns the timed closure.
 *
 * Schedule (this is the load-bearing correctness code):
 *  - Warm up BOTH sizes up front, or round 1 times cold-JIT code for one size.
 *  - One raw timing per size per round (no nested median).
 *  - Alternate the within-round order across rounds (even: small→large, odd:
 *    large→small). Interleaving cancels random second-to-second noise;
 *    alternating also cancels monotonic drift (a runner getting steadily busier
 *    would otherwise bias the always-later size the same way every round, and a
 *    median can't remove a bias present in every round).
 */
export function growthFactor(
  build: (n: number) => () => unknown,
  small: number,
  large: number,
  opts: { rounds?: number; warmup?: number } = {},
): number {
  const rounds = opts.rounds ?? RUNS;
  const warmup = opts.warmup ?? WARMUP;
  const smallFn = build(small);
  const largeFn = build(large);
  for (let i = 0; i < warmup; i++) smallFn();
  for (let i = 0; i < warmup; i++) largeFn();
  const ratios: number[] = [];
  for (let round = 0; round < rounds; round++) {
    let tSmall: number;
    let tLarge: number;
    if (round % 2 === 0) {
      tSmall = timeOnce(smallFn);
      tLarge = timeOnce(largeFn);
    } else {
      tLarge = timeOnce(largeFn);
      tSmall = timeOnce(smallFn);
    }
    ratios.push(tLarge / tSmall);
  }
  return median(ratios) / (large / small);
}

type PerfRecord = { label: string; value: number; bound: number; pass: boolean };

function recordResult(rec: PerfRecord): void {
  const file =
    process.env.PERF_RESULTS_FILE ?? path.join(process.cwd(), "perf-results.jsonl");
  fs.appendFileSync(file, `${JSON.stringify({ ...rec, ts: new Date().toISOString() })}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(
      summary,
      `| ${rec.label} | ${rec.value.toFixed(3)} | ${rec.bound} | ${rec.pass ? "✅" : "⚠️"} |\n`,
    );
  }
}

/**
 * Record a measurement, then gate on it. With `PERF_ENFORCE` unset (the
 * informational default) a breach is logged but does NOT throw, so nothing
 * blocks a merge while thresholds are being calibrated. With `PERF_ENFORCE`
 * set, a breach throws like a normal assertion. Tests never branch on the env
 * or write the summary themselves — that "how" lives here, which is why the
 * flip to gating is a one-line change.
 */
export function expectPerf(label: string, actual: number, bound: number): void {
  const pass = actual < bound;
  recordResult({ label, value: actual, bound, pass });
  const enforce = Boolean(process.env.PERF_ENFORCE);
  const line = `${pass ? "PASS" : "BREACH"} ${label}: ${actual.toFixed(3)} (bound ${bound})`;
  if (enforce && !pass) {
    throw new Error(`perf regression: ${line}`);
  }
  // eslint-disable-next-line no-console -- perf results are the point of the run
  console.log(`[perf] ${line}${enforce ? "" : " (informational)"}`);
}

// A counter so two calls in the same millisecond still get distinct paths.
let cacheFreeCounter = 0;

/**
 * The single home for parse-cache neutralization. Writes `source` to a fresh
 * unique temp path and returns it. The process-wide `parseAgencyFileCached`
 * keys on the file PATH (`${t|r}:${absPath}`), so a never-repeated path
 * guarantees a cache miss — while the CONTENT stays fixed, so the measured
 * workload does not vary run to run. Used only by the file-based compile /
 * incremental-build tests; the string-level tests never touch that cache.
 */
export function cacheFreePath(source: string, ext = ".agency"): string {
  const p = path.join(
    os.tmpdir(),
    `perf-cachefree-${process.pid}-${Date.now()}-${cacheFreeCounter++}${ext}`,
  );
  fs.writeFileSync(p, source, "utf-8");
  return p;
}
