import { describe, expect, it } from "vitest";

import { limitsFromConfig } from "./subprocess.js";

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

  it("ignores invalid wall-clock values (0, negative, NaN) and keeps the default", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(limitsFromConfig({ eval: { limits: { wallClockSec: bad } } }).wallClock).toBe(60_000);
    }
  });
});
