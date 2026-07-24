import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  measureMs,
  growthFactor,
  expectPerf,
  GROWTH_BOUND,
} from "./harness.js";

// A linear closure: O(n) work whose result is returned (so it is not
// dead-code-eliminated). Sized so a single call is comfortably measurable.
function linearWork(n: number): () => number {
  const arr = Array.from({ length: n }, (_, i) => i);
  return () => {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return sum;
  };
}

// A quadratic closure: O(n^2) work. At an 8x step this grows ~64x, so its
// normalized growth factor is ~8 — far above the bound.
function quadraticWork(n: number): () => number {
  return () => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) sum += i ^ j;
    }
    return sum;
  };
}

describe("perf harness", () => {
  it("measureMs returns a positive, roughly stable time", () => {
    const fn = linearWork(200_000);
    const a = measureMs(fn);
    const b = measureMs(fn);
    expect(a).toBeGreaterThan(0);
    // Same closure twice: within a wide tolerance (CI noise), not identical.
    expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(5);
  });

  it("canary: a quadratic algorithm's growth factor is well above the bound", () => {
    const factor = growthFactor(quadraticWork, 500, 4000);
    // Normalized quadratic ≈ 8 at an 8x step; assert it clears the bound with room.
    expect(factor).toBeGreaterThan(GROWTH_BOUND * 1.5);
  });

  it("self-consistency: a linear algorithm's growth factor is below the bound", () => {
    // This is the test the old RATIO_BOUND=8-vs-8x-step design would have failed
    // on correct code: a raw ratio of ~8 is not < 8. Normalization makes it ~1.
    const factor = growthFactor(linearWork, 500_000, 4_000_000);
    expect(factor).toBeLessThan(GROWTH_BOUND);
  });

  it("schedule: samples are interleaved, order-alternated, and warmed up front", () => {
    const log: number[] = [];
    const build = (n: number) => () => {
      log.push(n);
      return n;
    };
    const warmup = 2;
    const rounds = 4;
    growthFactor(build, 1, 8, { warmup, rounds });

    // Warmup prefix: `warmup` calls of small, then `warmup` of large — both
    // sizes warmed before any timed round.
    const prefix = log.slice(0, 2 * warmup);
    expect(prefix).toEqual([1, 1, 8, 8]);

    // Timed portion: `rounds` pairs, order alternating small→large, large→small.
    const timed = log.slice(2 * warmup);
    expect(timed).toHaveLength(2 * rounds);
    for (let r = 0; r < rounds; r++) {
      const pair = timed.slice(2 * r, 2 * r + 2);
      expect(pair).toEqual(r % 2 === 0 ? [1, 8] : [8, 1]);
    }
  });
});

describe("expectPerf recorder and gate", () => {
  let resultsFile: string;
  let savedEnforce: string | undefined;
  let savedFile: string | undefined;

  beforeEach(() => {
    resultsFile = path.join(os.tmpdir(), `perf-test-${process.pid}-${Date.now()}.jsonl`);
    savedEnforce = process.env.PERF_ENFORCE;
    savedFile = process.env.PERF_RESULTS_FILE;
    process.env.PERF_RESULTS_FILE = resultsFile;
    delete process.env.PERF_ENFORCE;
  });

  afterEach(() => {
    if (savedEnforce === undefined) delete process.env.PERF_ENFORCE;
    else process.env.PERF_ENFORCE = savedEnforce;
    if (savedFile === undefined) delete process.env.PERF_RESULTS_FILE;
    else process.env.PERF_RESULTS_FILE = savedFile;
    if (fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile);
  });

  it("records one parseable line per call, with the label and value", () => {
    expectPerf("test:label", 1.23, 2.0);
    const lines = fs.readFileSync(resultsFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.label).toBe("test:label");
    expect(rec.value).toBe(1.23);
    expect(rec.pass).toBe(true);
  });

  it("does not throw on a breach when PERF_ENFORCE is unset (informational)", () => {
    expect(() => expectPerf("test:breach", 9.0, 2.0)).not.toThrow();
  });

  it("throws on a breach when PERF_ENFORCE is set", () => {
    process.env.PERF_ENFORCE = "1";
    expect(() => expectPerf("test:breach", 9.0, 2.0)).toThrow(/perf regression/);
  });

  it("does not throw when under bound even with PERF_ENFORCE set", () => {
    process.env.PERF_ENFORCE = "1";
    expect(() => expectPerf("test:ok", 1.0, 2.0)).not.toThrow();
  });
});
