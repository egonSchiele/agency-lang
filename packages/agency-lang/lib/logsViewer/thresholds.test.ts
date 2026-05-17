import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  durationMagnitude,
  costMagnitude,
} from "./thresholds.js";

describe("durationMagnitude", () => {
  it("returns 'slow' at or above the slow threshold", () => {
    expect(durationMagnitude(DEFAULT_THRESHOLDS.slowMs)).toBe("slow");
    expect(durationMagnitude(DEFAULT_THRESHOLDS.slowMs + 1)).toBe("slow");
  });
  it("returns 'fast' below the fast threshold", () => {
    expect(durationMagnitude(0)).toBe("fast");
    expect(durationMagnitude(DEFAULT_THRESHOLDS.fastMs - 1)).toBe("fast");
  });
  it("returns 'normal' in the middle band", () => {
    expect(durationMagnitude(DEFAULT_THRESHOLDS.fastMs)).toBe("normal");
    expect(durationMagnitude(DEFAULT_THRESHOLDS.slowMs - 1)).toBe("normal");
  });
});

describe("costMagnitude", () => {
  it("returns 'expensive' at or above the expensive threshold", () => {
    expect(costMagnitude(DEFAULT_THRESHOLDS.expensiveUsd)).toBe("expensive");
    expect(costMagnitude(DEFAULT_THRESHOLDS.expensiveUsd + 0.001)).toBe("expensive");
  });
  it("returns 'cheap' below the expensive threshold", () => {
    expect(costMagnitude(0)).toBe("cheap");
    expect(costMagnitude(0.0001)).toBe("cheap");
  });
});
