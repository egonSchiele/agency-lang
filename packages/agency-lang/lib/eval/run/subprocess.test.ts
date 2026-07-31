import { afterEach, describe, expect, it } from "vitest";

import { costCapFromConfig, evalForkOptions, limitsFromConfig, makeCostCapTracker } from "./subprocess.js";

describe("limitsFromConfig", () => {
  it("keeps the built-in defaults when the config sets nothing", () => {
    const limits = limitsFromConfig({});
    expect(limits.wallClock).toBe(60_000);
    expect(limits.memory).toBe(512 * 1024 * 1024);
  });

  it("overrides the wall clock from eval.limits.wallClockSec", () => {
    const limits = limitsFromConfig({ eval: { limits: { wallClockSec: 600 } } });
    expect(limits.wallClock).toBe(600_000);
    // the other limits stay at their defaults
    expect(limits.memory).toBe(512 * 1024 * 1024);
    expect(limits.stdout).toBe(1024 * 1024);
  });

  it("treats an empty limits object as all-defaults", () => {
    expect(limitsFromConfig({ eval: { limits: {} } }).wallClock).toBe(60_000);
  });

  it("a per-test timeoutSec override beats the suite config", () => {
    const config = { eval: { limits: { wallClockSec: 900 } } };
    expect(limitsFromConfig(config, 1200).wallClock).toBe(1_200_000);
    expect(limitsFromConfig(config).wallClock).toBe(900_000);
  });

  it("ignores invalid wall-clock values (0, negative, NaN) and keeps the default", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(limitsFromConfig({ eval: { limits: { wallClockSec: bad } } }).wallClock).toBe(60_000);
    }
  });
});

describe("costCapFromConfig", () => {
  it("defaults to $50 and honors eval.limits.maxCostUsd", () => {
    expect(costCapFromConfig({})).toBe(50);
    expect(costCapFromConfig({ eval: { limits: { maxCostUsd: 5 } } })).toBe(5);
  });

  it("ignores invalid values (0, negative, NaN) and keeps the default", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(costCapFromConfig({ eval: { limits: { maxCostUsd: bad } } })).toBe(50);
    }
  });
});

describe("makeCostCapTracker", () => {
  it("accumulates payable costs and trips past the cap, ignoring junk", () => {
    const tracker = makeCostCapTracker(1);
    expect(tracker.add(0.4)).toBe(false);
    expect(tracker.add(NaN)).toBe(false);
    expect(tracker.add(-5)).toBe(false);
    expect(tracker.add("0.9" as unknown)).toBe(false);
    expect(tracker.add(0.61)).toBe(true);
    expect(tracker.total()).toBeCloseTo(1.01);
    expect(tracker.exceededMessage()).toMatch(/\$1\.01 spent, cap \$1\.00/);
  });
});

describe("evalForkOptions", () => {
  afterEach(() => {
    delete process.env.AGENCY_TRACE_ID;
  });

  it("strips AGENCY_TRACE_ID from a file-target child env — its trace id is its own run's", () => {
    process.env.AGENCY_TRACE_ID = "stray-or-harness-trace";
    const options = evalForkOptions(limitsFromConfig({}), "/tmp");
    expect((options.env as Record<string, string>).AGENCY_TRACE_ID).toBeUndefined();
    // the rest of the env still flows through
    expect((options.env as Record<string, string>).AGENCY_IPC).toBe("1");
  });
});
