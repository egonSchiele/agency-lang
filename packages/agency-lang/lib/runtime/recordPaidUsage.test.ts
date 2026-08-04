import { describe, it, expect, vi, afterEach } from "vitest";
import {
  recordPaidUsageAt,
  recordPaidUsage,
  recordUnknownCostAttempt,
  markInvocationUsageIncompleteAt,
  accountCompletionUsage,
} from "./recordPaidUsage.js";
import { completionUsageDelta, paidCostDelta } from "./invocationUsage.js";
import { addCost } from "./cost.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { CostGuard } from "./guard.js";
import { runInTestContext } from "./asyncContext.js";
import type { GraphState } from "./types.js";

function makeCtx() {
  return new RuntimeContext<GraphState>({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
  });
}

const originalSend = process.send;
afterEach(() => {
  process.send = originalSend;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("recordPaidUsageAt (explicit target)", () => {
  it("bills the given branch's cost + guards once and merges the meter once", () => {
    const ctx = makeCtx();
    const branch = new StateStack();
    const guard = new CostGuard(1);
    branch.guards.push(guard);
    recordPaidUsageAt({ ctx, stack: branch }, { pricedCost: 0.25, inputTokens: 100, outputTokens: 20, unknownCostCallCount: 0 });

    expect(branch.localCost).toBeCloseTo(0.25);
    // The invocation meter, not ctx.stateStack, saw the spend.
    expect(ctx.invocationUsage.snapshot().usage.pricedCost).toBeCloseTo(0.25);
    expect(ctx.invocationUsage.snapshot().usage.inputTokens).toBe(100);
    expect(ctx.stateStack.localCost).toBe(0);
  });

  it("relays the full delta once when in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    recordPaidUsageAt({ ctx: makeCtx(), stack: new StateStack() }, { pricedCost: 0.5, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0 });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "invocationUsage", pricedCost: 0.5, inputTokens: 1, outputTokens: 1, unknownCostCallCount: 0,
    });
  });

  it("an unpriced completion records tokens/unknown without charging guards", () => {
    const ctx = makeCtx();
    const branch = new StateStack();
    recordPaidUsageAt({ ctx, stack: branch }, completionUsageDelta({ cost: undefined, inputTokens: 5, outputTokens: 2, model: "m" }));
    expect(branch.localCost).toBe(0);
    const s = ctx.invocationUsage.snapshot();
    expect(s.usage.pricedCost).toBe(0);
    expect(s.usage.inputTokens).toBe(5);
    expect(s.usage.unknownCostCallCount).toBe(1);
    expect(s.usage.pricingComplete).toBe(false);
  });
});

describe("recordPaidUsage / addCost (ambient target)", () => {
  it("addCost records cost against the invocation meter and enforces guards", async () => {
    const ctx = makeCtx();
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => {
      addCost(0.25);
    });
    expect(ctx.invocationUsage.snapshot().usage.pricedCost).toBeCloseTo(0.25);
    expect(ctx.stateStack.localCost).toBeCloseTo(0.25);
  });

  it("addCost with an over-budget charge trips the guard (enforcement preserved)", async () => {
    const ctx = makeCtx();
    ctx.stateStack.guards.push(new CostGuard(0.1));
    await expect(
      runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => addCost(0.25)),
    ).rejects.toBeTruthy();
  });

  it("invalid addCost throws before any mutation (never a silent dropped charge)", async () => {
    const ctx = makeCtx();
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => {
      expect(() => addCost(-1)).toThrow();
      expect(() => addCost(NaN)).toThrow();
    });
    expect(ctx.stateStack.localCost).toBe(0);
    expect(ctx.invocationUsage.snapshot().usage.pricedCost).toBe(0);
  });

  it("recordPaidUsage delegates to the active frame", async () => {
    const ctx = makeCtx();
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => {
      recordPaidUsage(paidCostDelta(0.4));
    });
    expect(ctx.invocationUsage.snapshot().usage.pricedCost).toBeCloseTo(0.4);
  });
});

describe("recordUnknownCostAttempt", () => {
  it("adds one unknown-cost call, no cost, and flips pricingComplete false", () => {
    const ctx = makeCtx();
    recordUnknownCostAttempt(ctx, ctx.stateStack);
    const s = ctx.invocationUsage.snapshot();
    expect(s.usage.unknownCostCallCount).toBe(1);
    expect(s.usage.pricedCost).toBe(0);
    expect(s.usage.pricingComplete).toBe(false);
    expect(ctx.stateStack.localCost).toBe(0);
  });

  it("relays the unknown-cost delta upward in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx = makeCtx();
    recordUnknownCostAttempt(ctx, ctx.stateStack);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "invocationUsage", pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 1,
    });
  });
});

describe("markInvocationUsageIncompleteAt", () => {
  it("relays the marker only on the first transition", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx = makeCtx();
    markInvocationUsageIncompleteAt(ctx);
    markInvocationUsageIncompleteAt(ctx);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "invocationUsageIncomplete" });
    expect(ctx.invocationUsage.snapshot().usageComplete).toBe(false);
  });
});

describe("accountCompletionUsage", () => {
  it("attributes the completion to the provided model", () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    accountCompletionUsage(
      ctx,
      stack,
      { cost: { totalCost: 0.1 }, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      "opus-4.8",
    );
    const { usage } = ctx.invocationUsage.snapshot();
    expect(usage.models!["opus-4.8"]).toEqual({ pricedCost: 0.1, inputTokens: 5, outputTokens: 2 });
    expect(stack.localTokens).toBe(7);
  });
});
