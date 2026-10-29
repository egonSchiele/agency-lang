import { describe, expect, it } from "vitest";
import { LIMIT_CEILINGS } from "../../runtime/ipc.js";
import { MAX_TIME, wallClockFor } from "./limits.js";

describe("wallClockFor", () => {
  it("adds the headroom to maxTime", () => {
    expect(wallClockFor({ maxTime: 300000 })).toBe(330000);
  });

  it("is null without a maxTime, so run applies its own default", () => {
    expect(wallClockFor({ maxCost: 1 })).toBe(null);
    expect(wallClockFor(null)).toBe(null);
  });

  it("reaches exactly run's ceiling at the cap", () => {
    expect(wallClockFor({ maxTime: MAX_TIME })).toBe(LIMIT_CEILINGS.wallClock);
    expect(MAX_TIME).toBe(3570000);
  });
});
