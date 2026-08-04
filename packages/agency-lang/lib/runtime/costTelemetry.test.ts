import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isPayableCost,
  sendInvocationUsageToParent,
  sendInvocationUsageIncompleteToParent,
  sendModelAttributionIncompleteToParent,
} from "./costTelemetry.js";
import { completionUsageDelta, paidCostDelta } from "./invocationUsage.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard } from "./guard.js";

// process.send has no vi.stubEnv equivalent — save/restore it manually.
const originalSend = process.send;

afterEach(() => {
  process.send = originalSend;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isPayableCost", () => {
  it("accepts positive finite numbers only", () => {
    expect(isPayableCost(0.5)).toBe(true);
    expect(isPayableCost(0)).toBe(false);
    expect(isPayableCost(-1)).toBe(false);
    expect(isPayableCost(NaN)).toBe(false);
    expect(isPayableCost(Infinity)).toBe(false);
    expect(isPayableCost("0.5")).toBe(false);
    expect(isPayableCost(undefined)).toBe(false);
  });
});

describe("sendInvocationUsageToParent", () => {
  const delta = { pricedCost: 0.5, inputTokens: 100, outputTokens: 20, unknownCostCallCount: 0 };

  it("sends the full delta when in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "invocationUsage", ...delta });
  });

  it("relays attribution for a completion and an addCost charge", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;

    sendInvocationUsageToParent(completionUsageDelta({ cost: 0.1, inputTokens: 1, outputTokens: 1, model: "opus" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "invocationUsage",
      attribution: { kind: "model", model: "opus" },
    }));

    send.mockClear();
    sendInvocationUsageToParent(paidCostDelta(0.03));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "invocationUsage",
      attribution: { kind: "unattributed" },
    }));
  });

  it("sends a zero-cost unpriced delta (tokens/unknown must not be dropped)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent({ pricedCost: 0, inputTokens: 3, outputTokens: 1, unknownCostCallCount: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it("skips an all-zero delta", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent({ pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops outside IPC mode", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendInvocationUsageToParent(delta);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendInvocationUsageToParent(delta)).not.toThrow();
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

describe("sendModelAttributionIncompleteToParent", () => {
  it("sends the marker in IPC mode and no-ops otherwise", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendModelAttributionIncompleteToParent();
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv("AGENCY_IPC", "1");
    sendModelAttributionIncompleteToParent();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "modelAttributionIncomplete" });
  });
});

describe("StateStack.billCharge", () => {
  it("no longer emits telemetry (relay rides the recordPaidUsageAt boundary)", () => {
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
