/**
 * Performance-test harness: the measuring "how" so perf tests state only the
 * "what". We assert how work grows with input size, not absolute ms, so the
 * check survives noisy CI. Not vitest `bench`: it is mean-based with no seam
 * for a normalized ratio or the PERF_ENFORCE gate. Rationale in
 * docs/superpowers/specs/2026-07-24-ci-performance-tests-design.md.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Normalized: 1.0 = linear, ~step = quadratic. Start loose, calibrate from data. */
export const GROWTH_BOUND = 2.0;
export const WARMUP = 2;
export const RUNS = 7;

// Floor for a single timing before it goes into a ratio (guards divide-by-zero).
const MIN_MS = 1e-4;

/** Gating is on only when PERF_ENFORCE is set to a real truthy value. Treats
 *  "0"/"false"/"" as off so `PERF_ENFORCE=0` doesn't accidentally enable it
 *  (plain `Boolean("0")` is true). */
function perfEnforceEnabled(): boolean {
  const v = process.env.PERF_ENFORCE;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Written by every timed closure so V8 can't dead-code-eliminate the work.
let sink: unknown;

function timeOnce(fn: () => unknown): number {
  const start = performance.now();
  sink = fn();
  return performance.now() - start;
}

/** Median ms over `runs` timed calls after `warmup` untimed ones. For the
 *  absolute smoke checks; growthFactor times differently (a nested median
 *  would defeat its interleave). */
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
 * Normalized growth: 1.0 = linear, ~step = quadratic. `build(n)` does untimed
 * setup and returns the timed closure.
 *
 * The schedule is load-bearing: warm both sizes first, one timing per size per
 * round, and alternate the within-round order. Interleaving cancels random
 * noise; alternating also cancels monotonic drift (a fixed order would bias the
 * always-later size every round, which a median can't remove).
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
    // Floor each timing so a sample that measures as 0ms degrades to a finite
    // ratio instead of Infinity/NaN poisoning the median.
    ratios.push(Math.max(tLarge, MIN_MS) / Math.max(tSmall, MIN_MS));
  }
  return median(ratios) / (large / small);
}

type PerfRecord = { label: string; value: number; bound: number; pass: boolean };

function recordResult(rec: PerfRecord): void {
  const file = process.env.PERF_RESULTS_FILE ?? path.join(process.cwd(), "perf-results.jsonl");
  fs.appendFileSync(file, `${JSON.stringify({ ...rec, ts: new Date().toISOString() })}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(
      summary,
      `| ${rec.label} | ${rec.value.toFixed(3)} | ${rec.bound} | ${rec.pass ? "✅" : "⚠️"} |\n`,
    );
  }
}

/** Record, then gate: with PERF_ENFORCE unset a breach only logs (informational);
 *  set, it throws. Tests never touch the env, so the flip to gating is one line. */
export function expectPerf(label: string, actual: number, bound: number): void {
  const pass = actual < bound;
  recordResult({ label, value: actual, bound, pass });
  const enforce = perfEnforceEnabled();
  const line = `${pass ? "PASS" : "BREACH"} ${label}: ${actual.toFixed(3)} (bound ${bound})`;
  if (enforce && !pass) {
    throw new Error(`perf regression: ${line}`);
  }
  // eslint-disable-next-line no-console -- perf results are the point of the run
  console.log(`[perf] ${line}${enforce ? "" : " (informational)"}`);
}

let cacheFreeCounter = 0;

/** Writes `source` to a fresh unique temp path so the process-wide parse cache
 *  (keyed on path) always misses, with content fixed so the workload stays
 *  constant. Only the file-based compile/build tests need this. */
export function cacheFreePath(source: string, ext = ".agency"): string {
  const p = path.join(
    os.tmpdir(),
    `perf-cachefree-${process.pid}-${Date.now()}-${cacheFreeCounter++}${ext}`,
  );
  fs.writeFileSync(p, source, "utf-8");
  return p;
}
