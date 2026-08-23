import { describe, expect, it } from "vitest";

import { mapInParallel } from "./parallelMap.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapInParallel", () => {
  it("returns results in item order even when later items finish first", async () => {
    const result = await mapInParallel([30, 0, 10], 3, async (delay) => {
      await sleep(delay);
      return delay;
    });
    expect(result).toEqual([30, 0, 10]);
  });

  it("never runs more than `parallel` calls at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapInParallel([1, 2, 3, 4, 5], 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });

  it("treats a non-finite parallel as one worker", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapInParallel([1, 2, 3], Number.NaN, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(1);
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it("handles an empty list", async () => {
    expect(await mapInParallel([], 4, async () => 1)).toEqual([]);
  });
});
