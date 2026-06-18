import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./loop.js", () => ({ optimizeLoop: vi.fn() }));

import { optimizeLoop } from "./loop.js";
import { GreedyReflective } from "./greedyReflective.js";
import type { OptimizeLoopConfig, OptimizeResult } from "./types.js";

describe("GreedyReflective", () => {
  beforeEach(() => {
    vi.mocked(optimizeLoop).mockReset();
  });

  it("is named \"greedy\"", () => {
    expect(new GreedyReflective().name).toBe("greedy");
  });

  it("delegates optimize() to optimizeLoop and returns its result", async () => {
    const result = { runId: "r" } as OptimizeResult;
    vi.mocked(optimizeLoop).mockResolvedValue(result);
    const config = {} as OptimizeLoopConfig;
    const deps = {};

    const returned = await new GreedyReflective().optimize(config, deps);

    expect(optimizeLoop).toHaveBeenCalledWith(config, deps);
    expect(returned).toBe(result);
  });
});
