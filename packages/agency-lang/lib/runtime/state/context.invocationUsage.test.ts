import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";
import type { Checkpoint } from "./checkpointStore.js";

// The invocation meter is per-execCtx and must NOT survive a checkpoint restore
// (a resume leg starts fresh), nor appear in any serialization.
function makeContext() {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
  });
}

describe("execution-context invocation meter", () => {
  it("each createExecutionContext gets an independent, complete, zeroed meter", async () => {
    const parent = makeContext();
    const a = await parent.createExecutionContext("run-a");
    const b = await parent.createExecutionContext("run-b");

    expect(a.invocationUsage.snapshot()).toEqual({
      usage: {
        pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0, pricingComplete: true,
        models: {}, unattributed: { pricedCost: 0, inputTokens: 0, outputTokens: 0 },
        modelAttributionComplete: true,
      },
      usageComplete: true,
    });

    a.invocationUsage.merge({ pricedCost: 1, inputTokens: 10, outputTokens: 2, unknownCostCallCount: 1 });
    // b is untouched by a's spend (concurrent-invocation isolation).
    expect(b.invocationUsage.snapshot().usage.pricedCost).toBe(0);
    expect(b.invocationUsage.snapshot().usage.pricingComplete).toBe(true);
  });

  it("restoreState neither resets nor hydrates the meter (resume-leg isolation is structural)", async () => {
    const execCtx = await makeContext().createExecutionContext("run-1");
    execCtx.invocationUsage.merge({ pricedCost: 0.5, inputTokens: 7, outputTokens: 3, unknownCostCallCount: 0 });

    const checkpoint = execCtx.stateToJSON() as unknown as Checkpoint;
    execCtx.restoreState(checkpoint);

    // The meter is exactly what it was — restore did not touch it. (In real
    // resume the FRESH execCtx is what gives per-leg isolation; here we prove
    // restore itself carries no meter state.)
    expect(execCtx.invocationUsage.snapshot().usage.pricedCost).toBeCloseTo(0.5);
  });

  it("no serialization includes the meter", async () => {
    const execCtx = await makeContext().createExecutionContext("run-2");
    execCtx.invocationUsage.merge({ pricedCost: 9.99, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0 });
    expect(JSON.stringify(execCtx.toJSON())).not.toContain("invocationUsage");
    expect(JSON.stringify(execCtx.stateToJSON())).not.toContain("9.99");
  });
});
