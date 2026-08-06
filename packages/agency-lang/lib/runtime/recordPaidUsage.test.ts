import { describe, it, expect, vi, afterEach } from "vitest";
import {
  recordUsage,
  recordUnresolvedAttempt,
  recordNormalizedUsageDelta,
  meteredDispatch,
  markInvocationUsageIncompleteAt,
} from "./recordPaidUsage.js";
import { addCost } from "./cost.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { CostGuard } from "./guard.js";
import { runInTestContext } from "./asyncContext.js";
import type { GraphState } from "./types.js";
import type { CostBreakdown, NormalizedDelta, TokenBreakdown } from "./invocationUsage.js";

const MAX = Number.MAX_SAFE_INTEGER;

function makeCtx() {
  return new RuntimeContext<GraphState>({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
  });
}

function zeroCost(): CostBreakdown {
  return { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" };
}
function zeroTokens(): TokenBreakdown {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 };
}
function delta(over: Partial<NormalizedDelta>): NormalizedDelta {
  return { cost: zeroCost(), tokens: zeroTokens(), unknownCostCallCount: 0, attributionLost: false, ...over };
}
function sentTypes(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map((c) => (c[0] as { type: string }).type);
}

const originalSend = process.send;
afterEach(() => {
  process.send = originalSend;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("recordUsage (provider + manual observations)", () => {
  it("records a priced completion: bills the target branch and merges the meter once", () => {
    const ctx = makeCtx();
    const branch = new StateStack();
    branch.guards.push(new CostGuard(1));
    recordUsage(ctx, branch, {
      type: "provider",
      kind: "completion",
      reportedModel: "opus",
      cost: { totalCost: 0.25, currency: "USD" } as any,
      tokens: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } as any,
    });
    expect(branch.localCost).toBeCloseTo(0.25);
    const { usage } = ctx.invocationUsage.snapshot();
    expect(usage.cost.totalCost).toBeCloseTo(0.25);
    expect(usage.tokens.inputTokens).toBe(100);
    expect(usage.entries.map((e) => `${e.kind}:${e.model}`)).toEqual(["completion:opus"]);
    // Billed the given branch, not ctx.stateStack.
    expect(ctx.stateStack.localCost).toBe(0);
  });

  it("records a manual charge as a manual entry (model '') and bills it", () => {
    const ctx = makeCtx();
    const branch = new StateStack();
    recordUsage(ctx, branch, { type: "manual", amount: 0.03 });
    expect(branch.localCost).toBeCloseTo(0.03);
    const { usage } = ctx.invocationUsage.snapshot();
    expect(usage.cost.totalCost).toBeCloseTo(0.03);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({ kind: "manual", model: "" });
    expect(usage.entries[0].cost.totalCost).toBeCloseTo(0.03);
  });

  it("keeps a separate entry per model", () => {
    const ctx = makeCtx();
    const b = new StateStack();
    recordUsage(ctx, b, { type: "provider", kind: "completion", reportedModel: "opus", cost: { totalCost: 0.1, currency: "USD" } as any });
    recordUsage(ctx, b, { type: "provider", kind: "completion", reportedModel: "sonnet", cost: { totalCost: 0.2, currency: "USD" } as any });
    expect(ctx.invocationUsage.snapshot().usage.entries.map((e) => e.model)).toEqual(["opus", "sonnet"]);
  });
});

describe("recordUnresolvedAttempt", () => {
  it("adds one unknown-cost call, no cost, and flips pricingComplete false", () => {
    const ctx = makeCtx();
    recordUnresolvedAttempt(ctx, ctx.stateStack, "completion");
    const { usage } = ctx.invocationUsage.snapshot();
    expect(usage.unknownCostCallCount).toBe(1);
    expect(usage.pricingComplete).toBe(false);
    expect(usage.cost.totalCost).toBe(0);
    expect(ctx.stateStack.localCost).toBe(0);
  });
});

describe("recordUsageDelta sink: order, suppression, and degrade-once", () => {
  it("relays the delta, then ONE incompleteness marker after it, on attribution loss", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx = makeCtx();
    recordNormalizedUsageDelta(ctx, new StateStack(), delta({
      cost: { ...zeroCost(), totalCost: 0.5 },
      tokens: { ...zeroTokens(), inputTokens: 1, totalTokens: 1 },
      attributionLost: true,
    }));
    // FIFO preserves the recovered money before degrading the ancestor.
    expect(sentTypes(send)).toEqual(["invocationUsage", "invocationUsageIncomplete"]);
    expect(ctx.invocationUsage.snapshot().usageComplete).toBe(false);
  });

  it("a no-op (all-zero) delta emits no IPC message", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    recordNormalizedUsageDelta(makeCtx(), new StateStack(), delta({}));
    expect(send).not.toHaveBeenCalled();
  });

  it("outside IPC mode nothing is emitted even for a real delta", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    recordNormalizedUsageDelta(makeCtx(), new StateStack(), delta({ cost: { ...zeroCost(), totalCost: 1 } }));
    expect(send).not.toHaveBeenCalled();
  });

  it("a count overflow degrades once: marker only on the first transition, always after the delta", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx = makeCtx();
    const branch = new StateStack();
    recordNormalizedUsageDelta(ctx, branch, delta({ tokens: { ...zeroTokens(), inputTokens: MAX, totalTokens: MAX } }));
    send.mockClear();
    recordNormalizedUsageDelta(ctx, branch, delta({ tokens: { ...zeroTokens(), inputTokens: 1, totalTokens: 1 } }));
    expect(sentTypes(send)).toEqual(["invocationUsage", "invocationUsageIncomplete"]);
    send.mockClear();
    recordNormalizedUsageDelta(ctx, branch, delta({ tokens: { ...zeroTokens(), inputTokens: 1, totalTokens: 1 } }));
    expect(sentTypes(send)).toEqual(["invocationUsage"]);
    const s = ctx.invocationUsage.snapshot();
    expect(s.usage.tokens.inputTokens).toBe(MAX);
    expect(s.usageComplete).toBe(false);
  });
});

describe("meteredDispatch", () => {
  it("a resolved dispatch records nothing", async () => {
    const ctx = makeCtx();
    await meteredDispatch(ctx, ctx.stateStack, "completion", async () => "ok");
    expect(ctx.invocationUsage.snapshot().usage.unknownCostCallCount).toBe(0);
  });

  it("a rejected dispatch records exactly one unresolved attempt", async () => {
    const ctx = makeCtx();
    await expect(
      meteredDispatch(ctx, ctx.stateStack, "completion", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await Promise.resolve();
    expect(ctx.invocationUsage.snapshot().usage.unknownCostCallCount).toBe(1);
  });

  it("returns the dispatch promise unchanged (no extra microtask tick)", () => {
    const ctx = makeCtx();
    const p = Promise.resolve(7);
    expect(meteredDispatch(ctx, ctx.stateStack, "completion", () => p)).toBe(p);
  });
});

describe("addCost (ambient target)", () => {
  it("records a manual charge against the active frame and enforces guards", async () => {
    const ctx = makeCtx();
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => addCost(0.25));
    expect(ctx.invocationUsage.snapshot().usage.cost.totalCost).toBeCloseTo(0.25);
    expect(ctx.stateStack.localCost).toBeCloseTo(0.25);
  });

  it("an over-budget charge trips the guard (enforcement preserved)", async () => {
    const ctx = makeCtx();
    ctx.stateStack.guards.push(new CostGuard(0.1));
    await expect(
      runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => addCost(0.25)),
    ).rejects.toBeTruthy();
  });

  it("rejects a negative or non-finite amount before any mutation", async () => {
    const ctx = makeCtx();
    const msg = "addCost: amount must be a finite, non-negative number";
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), async () => {
      expect(() => addCost(-1)).toThrow(msg);
      expect(() => addCost(Number.NaN)).toThrow(msg);
      expect(() => addCost(Number.POSITIVE_INFINITY)).toThrow(msg);
    });
    expect(ctx.stateStack.localCost).toBe(0);
    expect(ctx.invocationUsage.snapshot().usage.cost.totalCost).toBe(0);
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
