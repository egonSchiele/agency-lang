import { describe, it, expect } from "vitest";
import { GlobalStore } from "./globalStore.js";

describe("GlobalStore token stats", () => {
  it("should get token stats", () => {
    const store = GlobalStore.withTokenStats();
    const stats = store.getTokenStats();
    expect(stats).toBeDefined();
    expect(stats.usage.inputTokens).toBe(0);
  });

  it("should restore token stats", () => {
    const store = GlobalStore.withTokenStats();
    const newStats = {
      usage: { inputTokens: 999, outputTokens: 500, cachedInputTokens: 0, totalTokens: 1499 },
      cost: { inputCost: 0.01, outputCost: 0.02, totalCost: 0.03, currency: "USD" },
    };
    store.restoreTokenStats(newStats);
    expect(store.getTokenStats().usage.inputTokens).toBe(999);
    expect(store.getTokenStats().cost.totalCost).toBe(0.03);
  });
});
