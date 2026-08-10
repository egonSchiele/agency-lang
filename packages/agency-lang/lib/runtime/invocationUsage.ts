// Per-invocation usage accounting for the serve cost seam.
//
// A hosted invocation must report the complete cost/token breakdown it incurred:
// an AUTHORITATIVE flat total (`usage.cost`/`usage.tokens`) plus a BEST-EFFORT
// per-`(kind, model)` attribution (`usage.entries`). Call sites emit one of three
// domain observations; `normalizeObservation` turns each into a `NormalizedDelta`;
// `InvocationUsageMeter` accumulates. Untrusted IPC input goes through
// `normalizeIpcUsageDelta`, which recovers every independently-valid field and
// degrades `usageComplete` rather than dropping money.

import type { EmbedResult, ImageGenResult, PromptResult } from "smoltalk";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";
import { resolveCompletionModel } from "./modelIdentity.js";

type SmoltalkCost = NonNullable<
  PromptResult["cost"] | EmbedResult["costEstimate"] | ImageGenResult["costEstimate"]
>;
type SmoltalkTokens = NonNullable<
  PromptResult["usage"] | EmbedResult["tokenUsage"] | ImageGenResult["tokenUsage"]
>;

export type ProviderUsageKind =
  | "completion"
  | "embedding"
  | "image"
  | "transcription"
  | "speech";
export type UsageKind = ProviderUsageKind | "manual";
const USAGE_KINDS: readonly UsageKind[] = [
  "completion",
  "embedding",
  "image",
  "transcription",
  "speech",
  "manual",
];

export type CostBreakdown = {
  inputCost: number;
  outputCost: number;
  cachedInputCost: number;
  cacheCreationInputCost: number;
  hostedToolsCost: number;
  totalCost: number;
  currency: "USD";
};
export type TokenBreakdown = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
};
export type UsageEntry = {
  kind: UsageKind;
  model: string; // "" is the manual sentinel; provider kinds always non-empty
  cost: CostBreakdown;
  tokens: TokenBreakdown;
};
export type InvocationUsage = {
  cost: CostBreakdown; // AUTHORITATIVE flat total (billed)
  tokens: TokenBreakdown; // AUTHORITATIVE flat total
  unknownCostCallCount: number;
  pricingComplete: boolean; // === (unknownCostCallCount === 0)
  entries: UsageEntry[]; // best-effort attribution, one per (kind, model)
};
export type InvocationUsageSnapshot = {
  usage: InvocationUsage;
  /** ⚠️ SIBLING of `usage`. When false, the whole figure is a trusted LOWER
   *  BOUND (abnormal subprocess termination, or recovered-but-degraded IPC).
   *  Distinct axis from `usage.pricingComplete` (price availability). */
  usageComplete: boolean;
};
export type UsageObservation =
  | {
      type: "provider";
      kind: ProviderUsageKind;
      reportedModel?: string | null;
      configuredModel?: string | null;
      cost?: SmoltalkCost | null;
      tokens?: SmoltalkTokens | null;
    }
  | { type: "attempt"; kind: ProviderUsageKind }
  | { type: "manual"; amount: number };
export type NormalizedDelta = {
  entry?: UsageEntry;
  cost: CostBreakdown;
  tokens: TokenBreakdown;
  unknownCostCallCount: number;
  attributionLost: boolean;
};

// `traceId` is the invocation's effective root trace id (the id events were
// stamped with). It rides the outcome so the serve adapter can echo it on the
// RouteResult without re-deriving identity.
export type ServedInvocationOutcome<T> =
  | ({ status: "returned"; value: T; traceId: string } & InvocationUsageSnapshot)
  | ({ status: "threw"; error: unknown; traceId: string } & InvocationUsageSnapshot);

export type InvocationAccountingTarget = {
  ctx: RuntimeContext<GraphState>;
  stack: StateStack;
};

/** Reconciliation tolerance for the best-effort attribution vs. the authoritative
 *  total (relative+absolute; float ulp drift scales with magnitude). Reconciled
 *  only when telemetry is complete; the flat total is always authoritative. */
export const USAGE_RECONCILE_ABS_USD = 1e-9;
export const USAGE_RECONCILE_REL = 1e-9;
export function usageReconcileTolerance(total: number): number {
  return Math.max(USAGE_RECONCILE_ABS_USD, USAGE_RECONCILE_REL * Math.abs(total));
}

const MAX_COUNT = Number.MAX_SAFE_INTEGER;

/** Add two counts without ever performing the unsafe addition first: saturate at
 *  MAX_COUNT and report it, so the caller can degrade `usageComplete`. */
function checkedAddCount(left: number, right: number): { value: number; saturated: boolean } {
  if (right > MAX_COUNT - left) {
    return { value: MAX_COUNT, saturated: true };
  }
  return { value: left + right, saturated: false };
}

function isFiniteNonNeg(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function costComponent(value: unknown): number {
  return isFiniteNonNeg(value) ? value : 0;
}

function zeroCost(): CostBreakdown {
  return { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" };
}
function zeroTokens(): TokenBreakdown {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 };
}
function copyCost(cost: CostBreakdown): CostBreakdown {
  return { ...cost };
}
function copyTokens(tokens: TokenBreakdown): TokenBreakdown {
  return { ...tokens };
}

/** Build a cost breakdown from a (trusted or untrusted) estimate-shaped object.
 *  A price is valid only when `totalCost` is finite-nonnegative AND currency is
 *  USD; otherwise every field is zero and the call is unpriced (`priced=false`).
 *  Named components are copied independently (best-effort, no sum-to-total). */
function buildCost(raw: unknown): { cost: CostBreakdown; priced: boolean } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const priced = obj !== undefined && isFiniteNonNeg(obj.totalCost) && obj.currency === "USD";
  if (!priced || obj === undefined) {
    return { cost: zeroCost(), priced: false };
  }
  return {
    cost: {
      inputCost: costComponent(obj.inputCost),
      outputCost: costComponent(obj.outputCost),
      cachedInputCost: costComponent(obj.cachedInputCost),
      cacheCreationInputCost: costComponent(obj.cacheCreationInputCost),
      hostedToolsCost: costComponent(obj.hostedToolsCost),
      totalCost: obj.totalCost as number,
      currency: "USD",
    },
    priced: true,
  };
}

/** One token counter. Absent (undefined/null) is a benign 0; a present malformed
 *  value is 0 AND flags malformed (for `attributionLost`). `absentDegrades`
 *  distinguishes trusted providers (absent OK) from untrusted IPC (absent bad). */
function tokenCounter(value: unknown, absentDegrades: boolean): { value: number; malformed: boolean } {
  if (value === undefined || value === null) {
    return { value: 0, malformed: absentDegrades };
  }
  if (isSafeCount(value)) {
    return { value, malformed: false };
  }
  return { value: 0, malformed: true };
}

/** Kind-specific total-token fallback when the provider omits/malforms it.
 *  completion normalizes cached vs ordinary input into disjoint buckets (add all);
 *  embedding/image cached counts may overlap input (add input+output only). */
function fallbackTotalTokens(kind: UsageKind, t: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number }): { value: number; saturated: boolean } {
  const parts = kind === "completion"
    ? [t.inputTokens, t.outputTokens, t.cachedInputTokens, t.cacheCreationInputTokens]
    : [t.inputTokens, t.outputTokens];
  let acc = 0;
  let saturated = false;
  for (const part of parts) {
    const next = checkedAddCount(acc, part);
    acc = next.value;
    saturated = saturated || next.saturated;
  }
  return { value: acc, saturated };
}

/**
 * The ONE closed projection of a provider's raw token usage. Every consumer of a
 * completion/audio usage — the invocation meter (via `recordUsage`), the branch
 * total (`stack.localTokens`), the global token stats, and every statelog payload
 * — must run raw usage through this before using it, so they all agree on the
 * total and none of them serialize an undeclared audio-token field. Wraps the
 * same `buildTokens` normalization the meter uses, so the numbers are identical
 * by construction. `attributionLost` is true when the total is only a lower bound
 * (audio counters present, no authoritative `totalTokens`).
 */
export function projectProviderTokenUsage(
  raw: unknown,
  kind: UsageKind = "completion",
): { usage: TokenBreakdown; attributionLost: boolean } {
  const { tokens, malformed } = buildTokens(raw, kind, false);
  return { usage: tokens, attributionLost: malformed };
}

function buildTokens(raw: unknown, kind: UsageKind, absentDegrades: boolean): { tokens: TokenBreakdown; malformed: boolean } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const input = tokenCounter(obj?.inputTokens, absentDegrades);
  const output = tokenCounter(obj?.outputTokens, absentDegrades);
  const cachedInput = tokenCounter(obj?.cachedInputTokens, false); // cache counters absent is normal
  const cacheCreation = tokenCounter(obj?.cacheCreationInputTokens, false);
  const partial = {
    inputTokens: input.value,
    outputTokens: output.value,
    cachedInputTokens: cachedInput.value,
    cacheCreationInputTokens: cacheCreation.value,
  };
  let malformed = input.malformed || output.malformed || cachedInput.malformed || cacheCreation.malformed;

  // Audio tokens (gpt-audio-1.5 chat) are collapsed into `totalTokens` and never
  // surface as their own fields (see plan §7a option A). When the provider's
  // `totalTokens` is authoritative it already includes them, so we do nothing.
  // Only in the FALLBACK branch — total absent/malformed — do we widen the lower
  // bound so an audio-heavy call is never undercounted: the plan's
  // max(text-sum, audio-sum) rule (a malformed audio counter contributes 0).
  const inputAudio = tokenCounter(obj?.inputAudioTokens, false);
  const outputAudio = tokenCounter(obj?.outputAudioTokens, false);
  const audioSum = checkedAddCount(inputAudio.value, outputAudio.value);
  const audioPresent = obj?.inputAudioTokens !== undefined || obj?.outputAudioTokens !== undefined;

  const rawTotal = obj?.totalTokens;
  let totalTokens: number;
  if (isSafeCount(rawTotal)) {
    totalTokens = rawTotal;
  } else {
    const fb = fallbackTotalTokens(kind, partial);
    totalTokens = Math.max(fb.value, audioSum.value);
    malformed = malformed || fb.saturated || audioSum.saturated;
    if (rawTotal !== undefined && rawTotal !== null) {
      malformed = true; // present-but-malformed provider total
    }
    // When audio counters are present but there is no authoritative total, the
    // max() is only a lower bound (we cannot tell whether the text counters
    // already include audio), so attribution is degraded — see plan §7a.
    if (audioPresent) {
      malformed = true;
    }
  }
  return { tokens: { ...partial, totalTokens }, malformed };
}

/** One UNTRUSTED IPC token field: a nonnegative safe integer survives; anything
 *  else (absent, negative, NaN, non-number) becomes 0 and degrades. Distinct
 *  from `tokenCounter`: at this boundary an absent field is never benign, and
 *  there is NO provider-kind fallback (a well-formed sender always transmits a
 *  full `NormalizedDelta`, so a gap is a broken/skewed child). */
function ipcCounter(value: unknown): { value: number; malformed: boolean } {
  if (isSafeCount(value)) {
    return { value, malformed: false };
  }
  return { value: 0, malformed: true };
}

/** Recover a token breakdown from UNTRUSTED IPC input, field by field. Each
 *  component follows the strict IPC rule (`ipcCounter`). `totalTokens`, when
 *  absent or malformed, falls back to a CONSERVATIVE `input + output` lower
 *  bound — never summing cache counters (they may overlap input) and never a
 *  provider-kind fallback — and degrades. */
function buildIpcTokens(raw: unknown): { tokens: TokenBreakdown; malformed: boolean } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const input = ipcCounter(obj?.inputTokens);
  const output = ipcCounter(obj?.outputTokens);
  const cachedInput = ipcCounter(obj?.cachedInputTokens);
  const cacheCreation = ipcCounter(obj?.cacheCreationInputTokens);
  let malformed = input.malformed || output.malformed || cachedInput.malformed || cacheCreation.malformed;

  let totalTokens: number;
  if (isSafeCount(obj?.totalTokens)) {
    totalTokens = obj.totalTokens as number;
  } else {
    totalTokens = checkedAddCount(input.value, output.value).value;
    malformed = true;
  }
  return {
    tokens: {
      inputTokens: input.value,
      outputTokens: output.value,
      cachedInputTokens: cachedInput.value,
      cacheCreationInputTokens: cacheCreation.value,
      totalTokens,
    },
    malformed,
  };
}

function anyToken(tokens: TokenBreakdown): boolean {
  return (
    tokens.inputTokens > 0 ||
    tokens.outputTokens > 0 ||
    tokens.cachedInputTokens > 0 ||
    tokens.cacheCreationInputTokens > 0 ||
    tokens.totalTokens > 0
  );
}

/** Turn a trusted domain observation into a normalized delta (the four
 *  provider outcomes + manual). `attributionLost` is set only by token
 *  malformation/saturation — never by pricing (which uses unknownCostCallCount). */
export function normalizeObservation(observation: UsageObservation): NormalizedDelta {
  if (observation.type === "attempt") {
    return { cost: zeroCost(), tokens: zeroTokens(), unknownCostCallCount: 1, attributionLost: false };
  }
  if (observation.type === "manual") {
    const cost: CostBreakdown = { ...zeroCost(), totalCost: observation.amount };
    const entry: UsageEntry = { kind: "manual", model: "", cost: copyCost(cost), tokens: zeroTokens() };
    return { entry, cost, tokens: zeroTokens(), unknownCostCallCount: 0, attributionLost: false };
  }
  const model = resolveCompletionModel(observation.reportedModel, observation.configuredModel);
  const { cost, priced } = buildCost(observation.cost);
  const { tokens, malformed } = buildTokens(observation.tokens, observation.kind, false);
  const entry: UsageEntry = { kind: observation.kind, model, cost: copyCost(cost), tokens: copyTokens(tokens) };
  return { entry, cost, tokens, unknownCostCallCount: priced ? 0 : 1, attributionLost: malformed };
}

function isUsageKind(value: unknown): value is UsageKind {
  return typeof value === "string" && (USAGE_KINDS as readonly string[]).includes(value);
}

/** Recover a normalized delta from UNTRUSTED IPC input. Never drops
 *  independently-valid money; a message carrying real value it cannot fully
 *  attribute preserves the authoritative totals, omits the entry, and sets
 *  `attributionLost` (which degrades `usageComplete`). Returns null only when the
 *  whole message is unusable (not an object). */
export function normalizeIpcUsageDelta(raw: unknown): NormalizedDelta | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  let attributionLost = obj.attributionLost === true;

  const { cost, priced } = buildCost(obj.cost);
  const { tokens, malformed } = buildIpcTokens(obj.tokens);
  if (malformed) attributionLost = true;

  let unknownCostCallCount = 0;
  if (isSafeCount(obj.unknownCostCallCount)) {
    unknownCostCallCount = obj.unknownCostCallCount;
  } else {
    attributionLost = true; // absent or present-but-malformed
  }
  if (!priced) {
    const bumped = checkedAddCount(unknownCostCallCount, 1);
    unknownCostCallCount = bumped.value;
    if (bumped.saturated) attributionLost = true;
  }

  const recovery = recoverIpcEntry(obj.entry);
  if (recovery.status === "invalid") {
    return { cost, tokens, unknownCostCallCount, attributionLost: true };
  }
  if (recovery.status === "absent") {
    // A well-formed provider/manual delta always carries its entry; an entry-less
    // delta is legitimate ONLY as an all-zero unresolved attempt. Measurable
    // money/tokens with no entry means attribution was lost in transit.
    if (cost.totalCost > 0 || anyToken(tokens)) attributionLost = true;
    return { cost, tokens, unknownCostCallCount, attributionLost };
  }
  if (recovery.malformed) attributionLost = true;
  return { entry: recovery.entry, cost, tokens, unknownCostCallCount, attributionLost };
}

type IpcEntryRecovery =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; entry: UsageEntry; malformed: boolean };

/** Recover an untrusted entry: valid iff kind ∈ UsageKind and the model sentinel
 *  invariant holds. Its cost/tokens are normalized independently and NEVER
 *  override the flat totals. `"invalid"` omits the entry and degrades; `"ok"`
 *  reports whether the entry's OWN components were malformed (an unpriced entry
 *  cost or a malformed token field), so the caller can degrade while keeping the
 *  usable entry. */
function recoverIpcEntry(raw: unknown): IpcEntryRecovery {
  if (raw === undefined || raw === null) {
    return { status: "absent" };
  }
  if (typeof raw !== "object") {
    return { status: "invalid" };
  }
  const obj = raw as Record<string, unknown>;
  if (!isUsageKind(obj.kind)) {
    return { status: "invalid" };
  }
  const kind = obj.kind;
  const model = obj.model;
  const modelOk = kind === "manual"
    ? model === ""
    : typeof model === "string" && model.length > 0;
  if (!modelOk) {
    return { status: "invalid" };
  }
  const { cost, priced } = buildCost(obj.cost);
  const { tokens, malformed } = buildIpcTokens(obj.tokens);
  return { status: "ok", entry: { kind, model: model as string, cost, tokens }, malformed: !priced || malformed };
}

/** A fresh, non-serialized accumulator for one invocation/leg. Buckets attribution
 *  by (kind, model) via a nested null-prototype index into `entries` (first-seen
 *  order); keeps authoritative call-order flat totals with checked-add saturation. */
export class InvocationUsageMeter {
  private cost: CostBreakdown = zeroCost();
  private tokens: TokenBreakdown = zeroTokens();
  private unknownCostCallCount = 0;
  private usageComplete = true;
  private entries: UsageEntry[] = [];
  private index: Record<UsageKind, Record<string, number>> = {
    completion: Object.create(null),
    embedding: Object.create(null),
    image: Object.create(null),
    transcription: Object.create(null),
    speech: Object.create(null),
    manual: Object.create(null),
  };

  /** Accumulate one delta. Returns true only when THIS merge newly makes usage
   *  incomplete (via a count-overflow transition). */
  merge(delta: NormalizedDelta): boolean {
    let saturated = false;
    this.addCostInto(this.cost, delta.cost);
    saturated = this.addTokensInto(this.tokens, delta.tokens) || saturated;
    const bumped = checkedAddCount(this.unknownCostCallCount, delta.unknownCostCallCount);
    this.unknownCostCallCount = bumped.value;
    saturated = saturated || bumped.saturated;

    if (delta.entry !== undefined) {
      const target = this.entryFor(delta.entry);
      this.addCostInto(target.cost, delta.entry.cost);
      saturated = this.addTokensInto(target.tokens, delta.entry.tokens) || saturated;
    }
    return saturated ? this.markIncomplete() : false;
  }

  private entryFor(entry: UsageEntry): UsageEntry {
    const perModel = this.index[entry.kind];
    const existing = perModel[entry.model];
    if (existing !== undefined) {
      return this.entries[existing];
    }
    const fresh: UsageEntry = { kind: entry.kind, model: entry.model, cost: zeroCost(), tokens: zeroTokens() };
    perModel[entry.model] = this.entries.length;
    this.entries.push(fresh);
    return fresh;
  }

  private addCostInto(target: CostBreakdown, add: CostBreakdown): void {
    target.inputCost += add.inputCost;
    target.outputCost += add.outputCost;
    target.cachedInputCost += add.cachedInputCost;
    target.cacheCreationInputCost += add.cacheCreationInputCost;
    target.hostedToolsCost += add.hostedToolsCost;
    target.totalCost += add.totalCost;
  }

  private addTokensInto(target: TokenBreakdown, add: TokenBreakdown): boolean {
    let saturated = false;
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "totalTokens"] as const) {
      const next = checkedAddCount(target[key], add[key]);
      target[key] = next.value;
      saturated = saturated || next.saturated;
    }
    return saturated;
  }

  /** Mark telemetry delivery no longer guaranteed complete. Idempotent; returns
   *  true only on the first complete → incomplete transition, so a caller relays
   *  a single upward marker. */
  markIncomplete(): boolean {
    if (!this.usageComplete) {
      return false;
    }
    this.usageComplete = false;
    return true;
  }

  snapshot(): InvocationUsageSnapshot {
    return {
      usage: {
        cost: copyCost(this.cost),
        tokens: copyTokens(this.tokens),
        unknownCostCallCount: this.unknownCostCallCount,
        pricingComplete: this.unknownCostCallCount === 0,
        entries: this.entries.map((entry) => ({ kind: entry.kind, model: entry.model, cost: copyCost(entry.cost), tokens: copyTokens(entry.tokens) })),
      },
      usageComplete: this.usageComplete,
    };
  }
}

/** Take a run core's outcome back to a raw value-or-throw, preserving the exact
 *  thrown value's identity (strings, frozen objects, anything). */
export function unwrapServedInvocationOutcome<T>(outcome: ServedInvocationOutcome<T>): T {
  if (outcome.status === "returned") {
    return outcome.value;
  }
  throw outcome.error;
}
