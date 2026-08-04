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

/** Reconciliation tolerance for the per-model breakdown vs. the authoritative
 *  flat total. Relative+absolute because float ulp drift scales with magnitude:
 *  a $10k total accumulated over a million calls drifts more than a $0.01 one.
 *  This is an accounting-precision policy, not a proof that every sub-threshold
 *  omitted charge is detectable — the flat total stays authoritative. A consumer
 *  that validates the breakdown MUST use this same function. */
export const USAGE_RECONCILE_ABS_USD = 1e-9;
export const USAGE_RECONCILE_REL = 1e-9;
export function usageReconcileTolerance(total: number): number {
  return Math.max(USAGE_RECONCILE_ABS_USD, USAGE_RECONCILE_REL * Math.abs(total));
}

/** Priced cost + input/output token counts for one model (or the unattributed
 *  bucket). Cost is a single total per model — input-vs-output cost is not split
 *  (the provider gives one `totalCost` through this seam). */
export type ModelUsageRow = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
};

/** How a charge is attributed. A discriminated value, not an optional model
 *  scalar, so "deliberately model-less" (addCost) is distinct from "provenance
 *  missing" (a received wire message an older runtime sent, whose delta simply
 *  has no `attribution` at all). */
export type UsageAttribution =
  | { kind: "model"; model: string }
  | { kind: "unattributed" };

export type InvocationUsage = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  pricingComplete: boolean;
  /** Per-model priced cost + input/output tokens. Real models only. The flat
   *  totals are authoritative; the rows plus `unattributed` are attribution that
   *  reconciles to them — cost within `usageReconcileTolerance(pricedCost)`, and
   *  token counts exactly WITHIN THE SAFE-INTEGER RANGE. The meter rejects any
   *  individual count at or above 2**53, and real token totals are far below it;
   *  only a subprocess relaying many absurd-but-safe counts whose ACCUMULATION
   *  crosses the safe range makes token reconciliation best-effort (like cost),
   *  never the flat total. Null-prototype so a provider model name like
   *  `__proto__` is a plain own key. Optional for back-compat; the current
   *  runtime always sets it. */
  models?: Record<string, ModelUsageRow>;
  /** Paid spend with no model (addCost: memory, image generation), plus any
   *  spend whose model was lost in transit. A separate field, not a key in
   *  `models`, so no sentinel can collide with a real model name. */
  unattributed?: ModelUsageRow;
  /** False when priced spend landed in `unattributed` because its model was
   *  lost (a version-skewed child), NOT because it was genuinely model-less.
   *  Distinct from `pricingComplete` (price availability) and `usageComplete`
   *  (telemetry delivery). */
  modelAttributionComplete?: boolean;
};

export type InvocationUsageDelta = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  /** How this charge is attributed. Absent means provenance-unknown — only
   *  reachable from a received wire message an older runtime sent. Locally-built
   *  deltas (completion, addCost) always set it. */
  attribution?: UsageAttribution;
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

/** A nonnegative SAFE integer (used for token/count fields). Values at or above
 *  2**53 are rejected: counts arrive from untrusted IPC, and above the safe
 *  range integer addition loses precision. This bounds each INDIVIDUAL count, so
 *  exact-token reconciliation holds within the safe range; it does not bound the
 *  ACCUMULATED total, so a malicious child relaying many safe counts that sum
 *  past the safe range makes token reconciliation best-effort (scoped on
 *  InvocationUsage.models). No real completion reports counts near this. */
function isValidCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Coerce an untrusted token/count field to a valid count, else 0. */
function asCount(value: unknown): number {
  return isValidCount(value) ? value : 0;
}

function newRow(): ModelUsageRow {
  return { pricedCost: 0, inputTokens: 0, outputTokens: 0 };
}

/** A fresh null-prototype map of fresh row objects — the meter never hands out a
 *  reference to its live rows. */
function copyModels(models: Record<string, ModelUsageRow>): Record<string, ModelUsageRow> {
  const out: Record<string, ModelUsageRow> = Object.create(null);
  for (const key of Object.keys(models)) out[key] = { ...models[key] };
  return out;
}

/** True when a delta carries priced cost or tokens (i.e. it will create a row).
 *  Owned here beside the delta type so meter bucketing and the IPC provenance
 *  check share one definition. */
export function isMeasurableDelta(delta: InvocationUsageDelta): boolean {
  return delta.pricedCost !== 0 || delta.inputTokens !== 0 || delta.outputTokens !== 0;
}

/** A fresh, non-serialized accumulator for one invocation/leg. */
export class InvocationUsageMeter {
  private pricedCost = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private unknownCostCallCount = 0;
  private usageComplete = true;
  private modelAttributionComplete = true;
  private models: Record<string, ModelUsageRow> = Object.create(null);
  private unattributed: ModelUsageRow = newRow();

  merge(delta: InvocationUsageDelta): void {
    this.pricedCost += delta.pricedCost;
    this.inputTokens += delta.inputTokens;
    this.outputTokens += delta.outputTokens;
    this.unknownCostCallCount += delta.unknownCostCallCount;

    // A charge with money or tokens lands in exactly one row — its model, or
    // the unattributed bucket (kind "unattributed" OR absent). This is what
    // keeps sum(models) + unattributed reconciled to the flat totals. `merge`
    // stays pure: the provenance-missing SIGNAL is raised at the IPC boundary,
    // not here.
    if (isMeasurableDelta(delta)) {
      const attribution = delta.attribution;
      const row = attribution?.kind === "model"
        ? (this.models[attribution.model] ??= newRow())
        : this.unattributed;
      row.pricedCost += delta.pricedCost;
      row.inputTokens += delta.inputTokens;
      row.outputTokens += delta.outputTokens;
    }
  }

  /** Mark telemetry delivery as no longer guaranteed complete. Idempotent;
   *  returns true only on the first complete → incomplete transition, so a
   *  caller can relay a single upward incompleteness marker. */
  markIncomplete(): boolean {
    if (!this.usageComplete) return false;
    this.usageComplete = false;
    return true;
  }

  /** Mark model attribution as no longer trustworthy (measurable spend arrived
   *  with a lost model). Idempotent; returns true only on the first transition
   *  so the caller relays a single upward marker — mirrors markIncomplete(). */
  markModelAttributionIncomplete(): boolean {
    if (!this.modelAttributionComplete) return false;
    this.modelAttributionComplete = false;
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
        models: copyModels(this.models),
        unattributed: { ...this.unattributed },
        modelAttributionComplete: this.modelAttributionComplete,
      },
      usageComplete: this.usageComplete,
    };
  }
}

/** A delta for a trusted LLM completion. A finite `0` cost is a known free price;
 *  an absent/negative/non-finite cost is UNKNOWN (no priced cost, one unknown
 *  call). Missing or invalid token counts contribute zero. The `model` is the
 *  resolved billing key (see resolveCompletionModel) — the charge is attributed
 *  to it even when its price is unknown. */
export function completionUsageDelta(args: {
  cost: number | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  model: string;
}): InvocationUsageDelta {
  const priced = isValidCost(args.cost);
  return {
    pricedCost: priced ? (args.cost as number) : 0,
    inputTokens: asCount(args.inputTokens),
    outputTokens: asCount(args.outputTokens),
    unknownCostCallCount: priced ? 0 : 1,
    attribution: { kind: "model", model: args.model },
  };
}

/** A delta for a trusted in-process paid charge (`addCost`). Invalid input
 *  THROWS — an addCost caller must never silently drop a real charge. Deliberately
 *  model-less: attributed `unattributed`, distinct on the wire from provenance-
 *  missing. */
export function paidCostDelta(amount: number): InvocationUsageDelta {
  if (!isValidCost(amount)) {
    throw new Error(`paidCostDelta: amount must be a finite, nonnegative number (got ${amount})`);
  }
  return {
    pricedCost: amount, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0,
    attribution: { kind: "unattributed" },
  };
}

/** Normalize an UNTRUSTED attribution (from an IPC message). A well-formed
 *  discriminated value survives; anything else becomes `undefined`
 *  (provenance-unknown — the IPC handler flags it). */
function normalizeAttribution(raw: unknown): UsageAttribution | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const attribution = raw as Record<string, unknown>;
  if (attribution.kind === "unattributed") return { kind: "unattributed" };
  if (attribution.kind === "model" && typeof attribution.model === "string" && attribution.model.length > 0) {
    return { kind: "model", model: attribution.model };
  }
  return undefined;
}

/** Normalize an UNTRUSTED delta (from an IPC message). Returns null only when the
 *  input is not a usable object. Otherwise each field is validated
 *  independently: an invalid `pricedCost` becomes zero priced cost plus one
 *  unknown-cost call (never a silent known-free zero), invalid token/count
 *  fields become zero, and a malformed/absent `attribution` becomes undefined —
 *  valid metadata is preserved even when cost is bad. */
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
    attribution: normalizeAttribution(obj.attribution),
  };
}

/** Take a run core's outcome back to a raw value-or-throw, preserving the exact
 *  thrown value's identity (strings, frozen objects, anything). */
export function unwrapServedInvocationOutcome<T>(outcome: ServedInvocationOutcome<T>): T {
  if (outcome.status === "returned") return outcome.value;
  throw outcome.error;
}
