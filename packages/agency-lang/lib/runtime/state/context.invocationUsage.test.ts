import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";
import type { Checkpoint } from "./checkpointStore.js";
import type { NormalizedDelta } from "../invocationUsage.js";

// The invocation meter is per-execCtx and must NOT survive a checkpoint restore
// (a resume leg starts fresh), nor appear in any serialization.
function makeContext() {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
  });
}

function delta(totalCost: number, over: Partial<NormalizedDelta> = {}): NormalizedDelta {
  return {
    cost: { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost, currency: "USD" },
    tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 },
    unknownCostCallCount: 0,
    attributionLost: false,
    ...over,
  };
}

describe("execution-context invocation meter", () => {
  it("each createExecutionContext gets an independent, complete, zeroed meter", async () => {
    const parent = makeContext();
    const a = await parent.createExecutionContext({ runId: "run-a" });
    const b = await parent.createExecutionContext({ runId: "run-b" });

    expect(a.invocationUsage.snapshot()).toEqual({
      usage: {
        cost: { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" },
        tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 },
        unknownCostCallCount: 0,
        pricingComplete: true,
        entries: [],
      },
      usageComplete: true,
    });

    a.invocationUsage.merge(delta(1, { unknownCostCallCount: 1 }));
    // b is untouched by a's spend (concurrent-invocation isolation).
    expect(b.invocationUsage.snapshot().usage.cost.totalCost).toBe(0);
    expect(b.invocationUsage.snapshot().usage.pricingComplete).toBe(true);
  });

  it("restoreState neither resets nor hydrates the meter (resume-leg isolation is structural)", async () => {
    const execCtx = await makeContext().createExecutionContext({ runId: "run-1" });
    execCtx.invocationUsage.merge(delta(0.5));

    const checkpoint = execCtx.stateToJSON() as unknown as Checkpoint;
    execCtx.restoreState(checkpoint);

    // The meter is exactly what it was — restore did not touch it. (In real
    // resume the FRESH execCtx is what gives per-leg isolation; here we prove
    // restore itself carries no meter state.)
    expect(execCtx.invocationUsage.snapshot().usage.cost.totalCost).toBeCloseTo(0.5);
  });

  it("no serialization includes the meter", async () => {
    const execCtx = await makeContext().createExecutionContext({ runId: "run-2" });
    execCtx.invocationUsage.merge(delta(9.99));
    expect(JSON.stringify(execCtx.toJSON())).not.toContain("invocationUsage");
    expect(JSON.stringify(execCtx.stateToJSON())).not.toContain("9.99");
  });
});
