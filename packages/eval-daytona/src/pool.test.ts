import { expect, it } from "vitest";

import { runPool } from "./pool.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

it("never runs more than `parallel` at once, and returns results in the items' order", async () => {
  let running = 0;
  let most = 0;
  const results = await runPool(
    [30, 5, 20, 1, 10],
    2,
    async (ms) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return ms * 2;
    },
    () => false,
  );
  expect(most).toBe(2);
  expect(results.map((entry) => entry.result)).toEqual([60, 10, 40, 2, 20]);
});

it("starts nothing more once shouldStop is true, and lets the running ones finish", async () => {
  let stop = false;
  const results = await runPool(
    ["a", "b", "c", "d"],
    2,
    async (item) => {
      await tick();
      if (item === "a") {
        stop = true;
      }
      return item.toUpperCase();
    },
    () => stop,
  );
  expect(results.map((entry) => entry.result)).toEqual(["A", "B", "not started", "not started"]);
});

it("returns nothing for no items", async () => {
  expect(await runPool([], 3, async () => 1, () => false)).toEqual([]);
});
