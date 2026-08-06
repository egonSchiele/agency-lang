import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sendInvocationUsageToParent,
  sendInvocationUsageIncompleteToParent,
} from "./costTelemetry.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard } from "./guard.js";
import type { CostBreakdown, NormalizedDelta, TokenBreakdown } from "./invocationUsage.js";

// process.send has no vi.stubEnv equivalent — save/restore it manually.
const originalSend = process.send;

afterEach(() => {
  process.send = originalSend;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function cost(over: Partial<CostBreakdown> = {}): CostBreakdown {
  return { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD", ...over };
}
function tokens(over: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, ...over };
}
function delta(over: Partial<NormalizedDelta> = {}): NormalizedDelta {
  return { cost: cost(), tokens: tokens(), unknownCostCallCount: 0, attributionLost: false, ...over };
}

describe("sendInvocationUsageToParent", () => {
  it("sends the complete nested delta when in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const d = delta({
      cost: cost({ totalCost: 0.5, inputCost: 0.3, outputCost: 0.2 }),
      tokens: tokens({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      entry: { kind: "completion", model: "opus", cost: cost({ totalCost: 0.5 }), tokens: tokens({ totalTokens: 120 }) },
    });
    sendInvocationUsageToParent(d);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "invocationUsage", ...d });
  });

  it("sends a zero-cost unpriced delta (tokens/unknown must not be dropped)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta({ tokens: tokens({ inputTokens: 3, totalTokens: 4 }), unknownCostCallCount: 1 }));
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends a delta that carries only an attribution-loss flag", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta({ attributionLost: true }));
    expect(send).toHaveBeenCalledOnce();
  });

  it("skips an all-zero delta", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta());
    expect(send).not.toHaveBeenCalled();
  });

  it("skips an all-zero manual entry (addCost(0) must not spam the channel)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta({ entry: { kind: "manual", model: "", cost: cost(), tokens: tokens() } }));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a manual entry that DOES carry cost", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta({ cost: cost({ totalCost: 0.03 }), entry: { kind: "manual", model: "", cost: cost({ totalCost: 0.03 }), tokens: tokens() } }));
    expect(send).toHaveBeenCalledOnce();
  });

  it("no-ops outside IPC mode", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta({ cost: cost({ totalCost: 0.5 }) }));
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendInvocationUsageToParent(delta({ cost: cost({ totalCost: 0.5 }) }))).not.toThrow();
  });
});

describe("sendInvocationUsageIncompleteToParent", () => {
  it("sends the marker in IPC mode and no-ops otherwise", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageIncompleteToParent();
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv("AGENCY_IPC", "1");
    sendInvocationUsageIncompleteToParent();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "invocationUsageIncomplete" });
  });
});

describe("StateStack.billCharge", () => {
  it("no longer emits telemetry (relay rides the recordPaidUsage boundary)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    new StateStack().billCharge(0.25);
    expect(send).not.toHaveBeenCalled();
  });

  it("accumulates localCost and really charges guards in one call", () => {
    const stack = new StateStack();
    const guard = new CostGuard(0.1);
    stack.guards.push(guard);
    stack.billCharge(0.25);
    expect(stack.localCost).toBe(0.25);
    expect(guard.check(stack)).not.toBeNull();
  });
});
