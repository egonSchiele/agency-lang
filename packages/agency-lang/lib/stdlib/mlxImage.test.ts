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

  it("gives the slowest allowed request, queued behind another, about two hours", () => {
    // Qwen-Image's estimated 5 s per step over one megapixel, doubled for
    // attention, at 80 steps over four megapixels, twice over.
    const worst = localImageTimeoutMs(MAX_STEPS, "2048x1952");
    expect(worst).toBeGreaterThan(100 * 60_000);
    expect(worst).toBeLessThan(130 * 60_000);
  });

  it("gives each family's default request room past its expected time", () => {
    // Z-Image at 9 steps runs about 8 s; Chroma at 40 about 90 s.
    // Qwen-Image at 50 is estimated at about 250 s.
    expect(localImageTimeoutMs(9, "1024x1024")).toBeGreaterThan(8_000 * 10);
    expect(localImageTimeoutMs(40, "1024x1024")).toBeGreaterThan(90_000 * 4);
    const qwen = localImageTimeoutMs(50, "1024x1024");
    expect(qwen).toBeGreaterThan(250_000 * 3);
    expect(qwen).toBeLessThan(30 * 60_000);
  });

  it("adds one megapixel of budget per reference picture", () => {
    const plain = localImageTimeoutMs(4, "1024x1024");
    const four = localImageTimeoutMs(4, "1024x1024", 4);
    // 1000x1000 is exactly one megapixel.
    expect(four - plain).toBe(4 * localImageTimeoutMs(4, "1000x1000"));
    expect(localImageTimeoutMs(4, "1024x1024", undefined)).toBe(plain);
  });

  it("budgets an empty size as 1024x1024", () => {
    expect(localImageTimeoutMs(4, "")).toBe(localImageTimeoutMs(4, "1024x1024"));
  });
});
