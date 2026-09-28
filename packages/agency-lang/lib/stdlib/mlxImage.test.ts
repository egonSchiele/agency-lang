import { describe, it, expect } from "vitest";
import { localImageTimeoutMs, MAX_STEPS } from "./mlxImage.js";

describe("localImageTimeoutMs", () => {
  it("grows with the steps and the size asked for", () => {
    const small = localImageTimeoutMs(9, "1024x1024");
    const moreSteps = localImageTimeoutMs(18, "1024x1024");
    const bigger = localImageTimeoutMs(9, "2048x1920");
    expect(moreSteps).toBe(small * 2);
    expect(bigger).toBeGreaterThan(small * 3);
  });

  it("budgets an unset or unusable step count at the most any family allows", () => {
    const most = localImageTimeoutMs(MAX_STEPS, "1024x1024");
    expect(localImageTimeoutMs(undefined, "1024x1024")).toBe(most);
    expect(localImageTimeoutMs("many", "1024x1024")).toBe(most);
    expect(localImageTimeoutMs(500, "1024x1024")).toBe(most);
  });

  it("budgets a size it cannot read at the pixel cap", () => {
    expect(localImageTimeoutMs(9, undefined)).toBe(localImageTimeoutMs(9, "2000x2000"));
    expect(localImageTimeoutMs(9, "big")).toBe(localImageTimeoutMs(9, "2000x2000"));
  });

  it("gives the slowest allowed request, queued behind another, most of an hour", () => {
    // Chroma's measured 90 s at 40 steps over one megapixel, doubled for
    // attention, at 80 steps over four megapixels, twice over.
    const worst = localImageTimeoutMs(MAX_STEPS, "2048x1952");
    expect(worst).toBeGreaterThan(45 * 60_000);
    expect(worst).toBeLessThan(60 * 60_000);
  });

  it("gives the default request a few minutes past its measured time", () => {
    // Z-Image at 9 steps runs about 8 s; Chroma at 40 about 90 s.
    const zImage = localImageTimeoutMs(9, "1024x1024");
    expect(zImage).toBeGreaterThan(90_000);
    expect(zImage).toBeLessThan(120_000);
    const chroma = localImageTimeoutMs(40, "1024x1024");
    expect(chroma).toBeGreaterThan(400_000);
    expect(chroma).toBeLessThan(480_000);
  });
});
