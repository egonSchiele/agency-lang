import { describe, it, expect, vi, afterEach } from "vitest";
import { isPayableCost, sendCostTelemetryToParent } from "./costTelemetry.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard } from "./guard.js";

// process.send has no vi.stubEnv equivalent — save/restore it manually.
// Env vars are stubbed per test and reset via vi.unstubAllEnvs(): a leaked
// AGENCY_IPC=1 would make every billCharge in later tests emit telemetry.
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

describe("sendCostTelemetryToParent", () => {
  it("sends the telemetry message when in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0.5);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "telemetry", costUsd: 0.5 });
  });

  it("no-ops outside IPC mode", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0.5);
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops for zero, negative, and non-finite cost", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0);
    sendCostTelemetryToParent(-1);
    sendCostTelemetryToParent(NaN);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendCostTelemetryToParent(0.5)).not.toThrow();
  });
});

describe("StateStack.billCharge", () => {
  it("emits exactly once per charge, even with zero guards installed", () => {
    // Emission must be unconditional on guards being present: a mid-tier
    // relay process may have NO local guards but must still forward the
    // grandchild spend upward.
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const stack = new StateStack();
    stack.billCharge(0.25);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "telemetry", costUsd: 0.25 });
  });

  it("does not emit for a zero charge", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    new StateStack().billCharge(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a direct chargeGuards call does NOT emit — emission rides the fresh-paid-charge semantic", () => {
    // Pins the hoist: re-applying spend to guard accumulators (restore /
    // reconciliation paths) must never double-bill the parent.
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    new StateStack().chargeGuards(0.25);
    expect(send).not.toHaveBeenCalled();
  });

  it("accumulates localCost and really charges guards in one call", () => {
    const stack = new StateStack();
    const guard = new CostGuard(0.1);
    stack.guards.push(guard);
    stack.billCharge(0.25);
    expect(stack.localCost).toBe(0.25);
    // 0.25 > 0.1: check() reporting a trip proves the guard was charged,
    // not just localCost.
    expect(guard.check(stack)).not.toBeNull();
  });
});
