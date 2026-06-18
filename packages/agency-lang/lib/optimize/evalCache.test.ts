import { describe, expect, it, vi } from "vitest";

import { EvalCache } from "./evalCache.js";
import type { AgentRun } from "./grading/types.js";

describe("EvalCache", () => {
  it("computes each (workspace,input) once and reuses the result", async () => {
    const cache = new EvalCache();
    const produce = vi.fn(async (): Promise<AgentRun> => ({ output: "x", recordPath: "p" }));
    const a = await cache.get("ws1", "in1", produce);
    const b = await cache.get("ws1", "in1", produce);
    expect(a).toBe(b);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("keys independently by workspace and input", async () => {
    const cache = new EvalCache();
    const produce = vi.fn(async (): Promise<AgentRun> => ({ output: "x", recordPath: "p" }));
    await cache.get("ws1", "in1", produce);
    await cache.get("ws2", "in1", produce);
    await cache.get("ws1", "in2", produce);
    expect(produce).toHaveBeenCalledTimes(3);
  });
});
