// Per-invocation usage accounting for the serve cost seam.
//
// A hosted invocation (`/node`, `/function`, `/resume`) must report the
// authoritative cost it just incurred so a host can attribute spend per
// project. This file owns the value types and the arithmetic:
//   - `InvocationUsageMeter` — a fresh, non-serialized accumulator that lives on
//     each execution context (see state/context.ts). One per invocation/leg.
//   - the delta helpers that turn a completion / an `addCost` charge / an
//     untrusted IPC message into a normalized `InvocationUsageDelta`.
//   - `ServedInvocationOutcome` — how a run core hands a value-or-error plus its
//     usage snapshot to the serve adapters without ever mutating the user value
//     or the thrown error.
//
// Two independent completeness axes, never conflated:
//   - `pricingComplete` (on the usage) — did every call have a price? Derived
//     from `unknownCostCallCount === 0`.
//   - `usageComplete` (on the snapshot) — was all telemetry delivered? Becomes
//     permanently false when an abnormal subprocess termination means we cannot
//     rule out unsent child usage, making `usage` a trusted LOWER BOUND.

import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";

export type InvocationUsage = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  pricingComplete: boolean;
};

export type InvocationUsageDelta = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
};

export type InvocationUsageSnapshot = {
  usage: InvocationUsage;
  /** ⚠️ A SIBLING of `usage`, not nested inside it — easy to miss. When `false`,
   *  the whole `usage` figure (including `pricedCost`) is a trusted LOWER BOUND:
   *  an abnormal subprocess termination means unsent child telemetry could not
   *  be ruled out. A consumer MUST treat the dollar total conservatively
   *  whenever this (or `usage.pricingComplete`) is false. Distinct axis from
   *  `pricingComplete`: that is about price availability, this is about
   *  telemetry delivery. */
  usageComplete: boolean;
};

export type ServedInvocationOutcome<T> =
  | ({ status: "returned"; value: T } & InvocationUsageSnapshot)
  | ({ status: "threw"; error: unknown } & InvocationUsageSnapshot);

/** Explicit ownership for an accounting call: which invocation's meter to merge
 *  into and which branch stack to bill. Passed explicitly so out-of-frame
 *  callers (the IPC telemetry handler) never depend on AsyncLocalStorage. */
export type InvocationAccountingTarget = {
  ctx: RuntimeContext<GraphState>;
  stack: StateStack;
};

/** A finite, nonnegative number (used for costs — `0` is a valid known price). */
function isValidCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A finite, nonnegative integer (used for token/count fields). */
function isValidCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/** Coerce an untrusted token/count field to a valid count, else 0. */
function asCount(value: unknown): number {
  return isValidCount(value) ? value : 0;
}

/** A fresh, non-serialized accumulator for one invocation/leg. */
export class InvocationUsageMeter {
  private pricedCost = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private unknownCostCallCount = 0;
  private usageComplete = true;

  merge(delta: InvocationUsageDelta): void {
    this.pricedCost += delta.pricedCost;
    this.inputTokens += delta.inputTokens;
    this.outputTokens += delta.outputTokens;
    this.unknownCostCallCount += delta.unknownCostCallCount;
  }

  /** Mark telemetry delivery as no longer guaranteed complete. Idempotent;
   *  returns true only on the first complete → incomplete transition, so a
   *  caller can relay a single upward incompleteness marker. */
  markIncomplete(): boolean {
    if (!this.usageComplete) return false;
    this.usageComplete = false;
    return true;
  }

  snapshot(): InvocationUsageSnapshot {
    return {
      usage: {
        pricedCost: this.pricedCost,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        unknownCostCallCount: this.unknownCostCallCount,
        pricingComplete: this.unknownCostCallCount === 0,
      },
      usageComplete: this.usageComplete,
    };
  }
}

/** A delta for a trusted LLM completion. A finite `0` cost is a known free price;
 *  an absent/negative/non-finite cost is UNKNOWN (no priced cost, one unknown
 *  call). Missing or invalid token counts contribute zero. */
export function completionUsageDelta(args: {
  cost: number | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
}): InvocationUsageDelta {
  const priced = isValidCost(args.cost);
  return {
    pricedCost: priced ? (args.cost as number) : 0,
    inputTokens: asCount(args.inputTokens),
    outputTokens: asCount(args.outputTokens),
    unknownCostCallCount: priced ? 0 : 1,
  };
}

/** A delta for a trusted in-process paid charge (`addCost`). Invalid input
 *  THROWS — an addCost caller must never silently drop a real charge. */
export function paidCostDelta(amount: number): InvocationUsageDelta {
  if (!isValidCost(amount)) {
    throw new Error(`paidCostDelta: amount must be a finite, nonnegative number (got ${amount})`);
  }
  return { pricedCost: amount, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0 };
}

/** Normalize an UNTRUSTED delta (from an IPC message). Returns null only when the
 *  input is not a usable object. Otherwise each field is validated
 *  independently: an invalid `pricedCost` becomes zero priced cost plus one
 *  unknown-cost call (never a silent known-free zero), and invalid token/count
 *  fields become zero — valid metadata is preserved even when cost is bad. */
export function normalizeUsageDelta(raw: unknown): InvocationUsageDelta | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const costValid = isValidCost(obj.pricedCost);
  const baseUnknown = asCount(obj.unknownCostCallCount);
  return {
    pricedCost: costValid ? (obj.pricedCost as number) : 0,
    inputTokens: asCount(obj.inputTokens),
    outputTokens: asCount(obj.outputTokens),
    unknownCostCallCount: costValid ? baseUnknown : baseUnknown + 1,
  };
}

/** Take a run core's outcome back to a raw value-or-throw, preserving the exact
 *  thrown value's identity (strings, frozen objects, anything). */
export function unwrapServedInvocationOutcome<T>(outcome: ServedInvocationOutcome<T>): T {
  if (outcome.status === "returned") return outcome.value;
  throw outcome.error;
}
