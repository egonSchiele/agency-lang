import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { growthFactor, expectPerf } from "./harness.js";

// Only the deterministic (timing-independent) harness tests live here, in the
// default unit suite. The timing-dependent ones (measureMs, canary,
// self-consistency) are in harness.perf.test.ts — the default suite runs files
// in parallel, and a `< GROWTH_BOUND` assertion on real timings could flake
// under that contention and block a merge. The serialized perf suite runs them
// safely.

describe("growthFactor schedule", () => {
  it("interleaves, order-alternates, and warms both sizes up front", () => {
    const log: number[] = [];
    const build = (n: number) => () => {
      log.push(n);
      return n;
    };
    const warmup = 2;
    const rounds = 4;
    growthFactor(build, 1, 8, { warmup, rounds });

    // Warmup prefix: `warmup` calls of small, then `warmup` of large.
    expect(log.slice(0, 2 * warmup)).toEqual([1, 1, 8, 8]);

    // Timed portion: `rounds` pairs, order alternating small→large, large→small.
    const timed = log.slice(2 * warmup);
    expect(timed).toHaveLength(2 * rounds);
    for (let r = 0; r < rounds; r++) {
      expect(timed.slice(2 * r, 2 * r + 2)).toEqual(r % 2 === 0 ? [1, 8] : [8, 1]);
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

  it("treats PERF_ENFORCE=0 as OFF (does not gate)", () => {
    process.env.PERF_ENFORCE = "0";
    expect(() => expectPerf("test:breach", 9.0, 2.0)).not.toThrow();
  });

  it("does not throw when under bound even with PERF_ENFORCE set", () => {
    process.env.PERF_ENFORCE = "1";
    expect(() => expectPerf("test:ok", 1.0, 2.0)).not.toThrow();
  });
});
