import { describe, it, expect } from "vitest";
import { isPaused, pausedResult } from "./pause.js";
import { makeCheckpoint } from "./checkpointTestHelpers.js";

describe("isPaused", () => {
  it("recognises a paused result", () => {
    const cp = makeCheckpoint();
    const paused = pausedResult(cp, "run-1");
    expect(paused).toEqual({ type: "paused", checkpoint: cp, runId: "run-1" });
    expect(isPaused(paused)).toBe(true);
  });

  it("rejects everything that is not a paused result", () => {
    const cp = makeCheckpoint();
    expect(isPaused(cp)).toBe(false);
    expect(isPaused([{ type: "interrupt" }])).toBe(false);
    expect(isPaused(null)).toBe(false);
    expect(isPaused("paused")).toBe(false);
    expect(isPaused({ type: "paused", checkpoint: null, runId: "r" })).toBe(false);
    expect(isPaused({ type: "paused", checkpoint: [], runId: "r" })).toBe(false);
    expect(isPaused({ type: "paused", checkpoint: cp, runId: "" })).toBe(false);
    expect(isPaused({ type: "paused", checkpoint: cp })).toBe(false);
  });
});
