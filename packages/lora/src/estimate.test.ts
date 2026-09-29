import { describe, it, expect } from "vitest";
import { estimateMinutes } from "./estimate.js";

describe("estimateMinutes", () => {
  it("counts the steps, the pixels, and the sample rounds", () => {
    // 1000 steps at 1024: 800 s. Two prompts every 250 steps: 5 rounds of
    // 2 images each, 10 s an image: 200 s. 1000 s in all.
    expect(estimateMinutes(1000, 1024, ["a", "b"], 250)).toBe(16.7);
    // At 512 a step costs a quarter, and no sample rounds with sampleEvery 0.
    expect(estimateMinutes(1000, 512, ["a"], 0)).toBe(3.3);
    // An extra round at the end when the steps do not divide evenly.
    expect(estimateMinutes(100, 1024, ["a"], 30)).toBe(3);
  });
});
