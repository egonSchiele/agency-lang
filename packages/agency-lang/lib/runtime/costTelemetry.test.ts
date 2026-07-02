import { describe, it, expect, vi, afterEach } from "vitest";
import { isPayableCost, sendCostTelemetryToParent } from "./costTelemetry.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard } from "./guard.js";

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
  const originalSend = process.send;
  const originalIpc = process.env.AGENCY_IPC;

  afterEach(() => {
    process.send = originalSend;
    if (originalIpc === undefined) delete process.env.AGENCY_IPC;
    else process.env.AGENCY_IPC = originalIpc;
    vi.restoreAllMocks();
  });

  it("sends the telemetry message when in IPC mode", () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0.5);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "telemetry", costUsd: 0.5 });
  });

  it("no-ops outside IPC mode", () => {
    delete process.env.AGENCY_IPC;
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0.5);
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops for zero, negative, and non-finite cost", () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCostTelemetryToParent(0);
    sendCostTelemetryToParent(-1);
    sendCostTelemetryToParent(NaN);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    process.env.AGENCY_IPC = "1";
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendCostTelemetryToParent(0.5)).not.toThrow();
  });
});

describe("StateStack.chargeGuards emission", () => {
  const originalSend = process.send;
  const originalIpc = process.env.AGENCY_IPC;

  afterEach(() => {
    process.send = originalSend;
    if (originalIpc === undefined) delete process.env.AGENCY_IPC;
    else process.env.AGENCY_IPC = originalIpc;
    vi.restoreAllMocks();
  });

  it("emits exactly once per charge, even with zero guards installed", () => {
    // Emission must be unconditional on guards being present: a mid-tier
    // relay process may have NO local guards but must still forward the
    // grandchild spend upward.
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    const stack = new StateStack();
    stack.chargeGuards(0.25);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "telemetry", costUsd: 0.25 });
  });

  it("does not emit for a zero charge", () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    new StateStack().chargeGuards(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("StateStack.billCharge", () => {
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
