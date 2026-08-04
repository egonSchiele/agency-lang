# Per-Model Cost Breakdown for the Serve Cost Seam — Design

> Revised after review (`2026-08-04-per-model-cost-breakdown-design-REVIEW.md`).
> Changes from v1: the synthetic `"(unattributed)"` map key is replaced by a
> structural `unattributed` field; exact `===` reconciliation is replaced by a
> named tolerance; the new usage fields are optional (public-type compat); a
> `modelAttributionComplete` axis is added; the model-identity contract is
> locked; the test plan is expanded.
>
> Changes from v2 (second review): the wire/delta carries a **discriminated
> `attribution` value**, not an optional `model` scalar — an absent scalar could
> not tell "deliberately model-less `addCost`" from "model lost by a
> version-skewed child," and the immediately-preceding #801 runtime emits
> model-less full deltas. `modelAttributionComplete` is therefore **not
> cuttable** and its trigger is "a measurable received IPC delta with no
> attribution." Tolerance is relative+absolute. Model identity is extracted into
> a pure `resolveCompletionModel` helper so its precedence is testable directly.

## Background: what already ships, and what it is missing

Agency can host an agent behind an HTTP endpoint (the "serve" path — `agency deploy` plus the `./serve` API). A hosting platform such as statelog runs these agents on behalf of paying customers, so it needs to know, for each individual invocation, exactly how much money that invocation cost. It cannot ask the customer's code to report its own spend honestly — the figure has to be produced by the runtime itself, where the customer cannot under-report it.

That figure already exists. The **serve cost seam** (shipped in PR #801) gives every hosted invocation a trustworthy per-invocation total. The machinery is:

- **`InvocationUsageMeter`** (`lib/runtime/invocationUsage.ts`) — a fresh, non-serialized counter that lives on each execution context. One is created per invocation and per resume leg in `createExecutionContext` (`lib/runtime/state/context.ts:402`) and thrown away when the invocation ends, so it counts only that one invocation's spend even when the host reuses a long-running process.
- **The single accounting boundary** `recordPaidUsageAt` (`lib/runtime/recordPaidUsage.ts:29`) — every paid unit of work (an LLM completion, an `addCost` charge, a subprocess child's relayed spend) submits one `InvocationUsageDelta` here. It bills the branch's cost guards, merges the delta into the meter, and — if this process is itself a subprocess — relays the delta up to its parent over IPC exactly once.
- **The snapshot** `InvocationUsageSnapshot` — `{ usage, usageComplete }`, handed back to the serve adapters and out to the host through `RouteResult` (`lib/serve/http/adapter.ts:61`).

Today the `usage` object carries only **lumped totals**:

```ts
// lib/runtime/invocationUsage.ts
export type InvocationUsage = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  pricingComplete: boolean;
};
```

The host receives "$0.15, 1600 input tokens, 390 output tokens" for the whole invocation, with no way to see that $0.10 of it was opus and $0.02 was haiku. This spec adds that per-model breakdown.

## Why we cannot just read the existing per-model map

Agency already keeps a per-model breakdown elsewhere: `updateTokenStats` (`lib/runtime/utils.ts:283`) writes `__tokenStats.models[model] = { inputTokens, outputTokens, ..., totalCost }` on every completion, and `normalizeModelUsage` reads it back. It is tempting to snapshot that map at the end of an invocation.

It does not work, for one specific reason: **`__tokenStats` cannot cross a subprocess boundary.** The stdlib `run()` tool (`lib/stdlib/agency.ts`) forks a real OS process to execute compiled Agency code. That child has its own `GlobalStore` and its own `__tokenStats`, which die with the child. The child's spend comes home only over IPC, and only into the parent's **meter** — the parent's `__tokenStats` is never told about the child (`lib/runtime/ipc.ts:956`, `accountChildUsage`, which calls `recordPaidUsageAt` and nothing else). The relayed IPC message does not even carry a model name (`IpcInvocationUsageMessage`, `lib/runtime/costTelemetry.ts:33`).

Concrete failure: a served function classifies with haiku ($0.02), then calls `run(...)` to summarize with opus ($0.10) in a subprocess.

```
meter total         = $0.12                (haiku + relayed opus — correct)
__tokenStats.models = { haiku: $0.02 }     (opus died with the child — sums to $0.02)
```

`__tokenStats.models` under-reports by $0.10, and its rows no longer reconcile to the total the host is billing. In-process subagents are fine (they pointer-share the parent's `__tokenStats`), but the stdlib `run()` tool is a supported feature, so we cannot assume no invocation ever forks. The per-model breakdown must ride the **same accumulator the total already rides** — the meter and its IPC wire — so the two stay consistent.

The shipped seam (#801) is **correct as-is** and needs no fix: the meter total already includes subprocess-relayed spend. This work is purely additive.

## Goal

Give every hosted invocation's usage snapshot a per-model breakdown of priced cost and input/output tokens that (a) includes subprocess-relayed spend, (b) reconciles to the invocation's total within a documented tolerance, and (c) tells the host when the model labels themselves cannot be trusted.

## Decisions baked into this design

1. **Granularity: cost + input/output tokens per model.** Each model row is `{ pricedCost, inputTokens, outputTokens }`, matching the fields the meter already tracks. (Cache-read / cache-write tokens are out of scope — the meter tracks neither today, and neither does the total.)

2. **Attribution is a discriminated value, and model-less spend is a structural field.** A charge's attribution is one of `{ kind: "model"; model: string }` or `{ kind: "unattributed" }`, carried on the delta and the IPC wire. Absence of an attribution value on a *received* wire message is a distinct, third state — "provenance unknown" (an older runtime). This matters because an optional `model` *scalar* cannot tell two very different things apart: `addCost` is deliberately model-less, while the immediately-preceding #801 runtime emits full `invocationUsage` deltas that simply predate any model field. Both would look like "no model." A discriminator makes "deliberately unattributed" and "provenance missing" separable. On the snapshot side, model-less spend lands in a dedicated `unattributed: ModelUsageRow` **field**, not a reserved key inside `models` — model identifiers are arbitrary strings (custom/local providers), so any sentinel key could collide with a real model.

3. **Reconciliation is approximate, within a relative+absolute tolerance — the flat total stays authoritative.** The flat `pricedCost` remains the authoritative running total, accumulated exactly as today (#801 untouched, so the host bills the same number). The per-model rows plus `unattributed` are *attribution* of that total. Float addition is not associative, so summing the rows (a different grouping of the same charges) can differ from the flat total by ulps whose magnitude scales with the total. The contract is therefore `|sum(models) + unattributed − pricedCost| ≤ usageReconcileTolerance(pricedCost)`, where `usageReconcileTolerance(t) = max(USAGE_RECONCILE_ABS_USD, USAGE_RECONCILE_REL * |t|)`. Token counts are integers and reconcile exactly. This tolerance covers ulp drift only; because every charge hits both the flat total and exactly one row by construction, a *missing* charge cannot arise from arithmetic — only from a code bug, which a reconciliation test guards against.

4. **A third completeness axis, `modelAttributionComplete` — NOT cuttable.** Two live IPC paths deliver priced spend with no attribution: the legacy `{costUsd}` handler (`handleTelemetryMessage`, `ipc.ts:969`) and a child running the #801 runtime, whose `invocationUsage` message has no attribution field. Booking that real LLM spend to `unattributed` silently misreports a model's spend as runtime spend, and neither `pricingComplete` (price availability) nor `usageComplete` (telemetry delivery) describes it. `modelAttributionComplete` starts true and flips false the moment a **measurable received delta arrives with no attribution value**. `addCost` and normal completions always carry an explicit attribution, so they never trip it. Because these skew paths are live, the axis cannot be cut without instead *rejecting* any child that omits the attribution discriminator.

5. **Model identity is a locked contract behind a pure helper.** The precedence "provider-reported model, else resolved/requested model, else `"unknown model"`" already lives inline at `prompt.ts:732` (`completion.model || clientConfig.model || "unknown model"`). Extract it into a pure `resolveCompletionModel(completionModel, configuredModel): string` used at that call site, so the precedence is unit-testable directly rather than only through the full prompt path. The string is the aggregation key verbatim (no provider-name normalization); a real model named `"unknown model"` is an ordinary row, never unattributed.

## The reconciliation invariant (precise form)

Every priced charge contributes its `pricedCost` / `inputTokens` / `outputTokens` to **both** the flat totals **and** exactly one destination: its model row (`attribution.kind === "model"`) or the `unattributed` row (`attribution.kind === "unattributed"`, or attribution absent). Therefore:

- Tokens: `sum(models[*].inputTokens) + unattributed.inputTokens === inputTokens` (exact — integers). Same for output.
- Cost: `|sum(models[*].pricedCost) + unattributed.pricedCost − pricedCost| ≤ usageReconcileTolerance(pricedCost)`.

Unknown-cost attempts (`recordUnknownCostAttempt`) carry zero cost and zero tokens, stay **invocation-level only** (they bump `unknownCostCallCount`), and are attributed to no row. `pricingComplete` likewise stays invocation-level. (Attributing unknown attempts per model is explicitly not v1.)

## Architecture: a discriminated attribution on the delta, threaded through the existing path

The delta already flows completion → boundary → meter → (IPC) → parent boundary → parent meter → snapshot. We add **one optional `attribution` value to the delta and the wire**, plus a `models` map, an `unattributed` row, and a `modelAttributionComplete` flag to the meter and snapshot. Each `recordPaidUsageAt` call is one charge, so a single attribution value is sufficient end to end — no map travels on the wire.

```
completion ─► attribution {kind:model, model} ─┐
addCost    ─► attribution {kind:unattributed}  ├─► InvocationUsageDelta { ..., attribution? } ─► recordPaidUsageAt
child IPC  ─► attribution (or ABSENT if #801)  ┘                                                  │
                                            ┌──────────────────┬─────────────────┴──────────┐
                                            ▼                  ▼                            ▼
                                     stack.billCharge    meter.merge(delta)          sendInvocationUsageToParent
                                                              │                       (relays attribution too)
                        kind model -> models[model];  kind unattributed OR absent -> unattributed
                        AND flat totals either way
                                                              │
                    IPC boundary: measurable delta with ABSENT attribution -> markModelAttributionIncompleteAt
                                                              │
                                          meter.snapshot() ─► usage.{models,unattributed,modelAttributionComplete}
                                                              │  ─► RouteResult.usage ─► host
```

---

## File-by-file changes

### 1. `lib/runtime/invocationUsage.ts` — types, meter, delta helpers

**New tolerance and per-model row / attribution types:**

```ts
/** Reconciliation tolerance for the per-model breakdown vs. the authoritative
 *  flat total. Relative+absolute because float ulp drift scales with magnitude:
 *  a $10k total accumulated over a million calls drifts more than a $0.01 one.
 *  The host MUST use this same function when it validates the breakdown. */
export const USAGE_RECONCILE_ABS_USD = 1e-9;
export const USAGE_RECONCILE_REL = 1e-9;
export function usageReconcileTolerance(total: number): number {
  return Math.max(USAGE_RECONCILE_ABS_USD, USAGE_RECONCILE_REL * Math.abs(total));
}

export type ModelUsageRow = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
};

/** How a charge is attributed. A discriminated value, not an optional scalar, so
 *  "deliberately model-less" (addCost) is distinct from "provenance missing"
 *  (an older child whose wire carried no attribution — the delta simply has no
 *  `attribution` at all). */
export type UsageAttribution =
  | { kind: "model"; model: string }
  | { kind: "unattributed" };
```

**Extend `InvocationUsage` — new fields OPTIONAL (public-type compat, review #3).** `InvocationUsage` is exported publicly (`lib/runtime/index.ts:143`); a required field would break TypeScript consumers that construct it. The current runtime always emits all three; absence means an older runtime (see rollout note).

```ts
export type InvocationUsage = {
  pricedCost: number;              // authoritative running total — UNCHANGED from #801
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  pricingComplete: boolean;
  /** Per-model priced cost + input/output tokens. Real models only. Rows plus
   *  `unattributed` reconcile to the flat total within
   *  USAGE_RECONCILE_TOLERANCE_USD (cost) / exactly (tokens). Null-prototype so
   *  a provider model name like `__proto__` is a plain own key. Optional for
   *  back-compat; the current runtime always sets it. */
  models?: Record<string, ModelUsageRow>;
  /** Paid spend with no model (addCost: memory, image generation). A separate
   *  field, not a key in `models`, so no sentinel can collide with a real
   *  model name. */
  unattributed?: ModelUsageRow;
  /** False when priced spend was attributed to `unattributed` because its model
   *  was lost in transit (a version-skewed child through the legacy IPC path),
   *  NOT because it was genuinely model-less. Distinct from `pricingComplete`
   *  (price availability) and `usageComplete` (telemetry delivery). */
  modelAttributionComplete?: boolean;
};
```

**Add optional `attribution` to the delta:**

```ts
export type InvocationUsageDelta = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  /** How this charge is attributed. Absent means provenance-unknown — only
   *  possible from a received wire message an older runtime sent. Locally-built
   *  deltas (completion, addCost) always set it. */
  attribution?: UsageAttribution;
};
```

**`InvocationUsageMeter` grows a `models` map, an `unattributed` row, and a `modelAttributionComplete` flag.** `merge` files a charge into a bucket only when it carries cost or tokens (a pure unknown-cost delta makes no row). Absent attribution buckets to `unattributed` here — but `merge` stays pure; the incompleteness *signal* is raised at the IPC boundary (File 5), not inside `merge`:

```ts
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

    if (delta.pricedCost !== 0 || delta.inputTokens !== 0 || delta.outputTokens !== 0) {
      const attr = delta.attribution;
      const row = attr?.kind === "model"
        ? (this.models[attr.model] ??= newRow())
        : this.unattributed;              // kind "unattributed" OR absent
      row.pricedCost += delta.pricedCost;
      row.inputTokens += delta.inputTokens;
      row.outputTokens += delta.outputTokens;
    }
  }

  /** Mark model attribution as no longer trustworthy. Idempotent; returns true
   *  only on the first transition so the caller relays a single upward marker —
   *  mirrors markIncomplete(). */
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
        models: copyModels(this.models),          // fresh null-proto map of fresh rows
        unattributed: { ...this.unattributed },   // fresh copy
        modelAttributionComplete: this.modelAttributionComplete,
      },
      usageComplete: this.usageComplete,
    };
  }
}
```

`newRow()` returns `{ pricedCost: 0, inputTokens: 0, outputTokens: 0 }`; `copyModels` is a small local helper returning a fresh null-prototype map of fresh row objects (owns the snapshot-copy invariant; keep both local).

**`completionUsageDelta` takes the model and sets `{ kind: "model" }`:**

```ts
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
```

**`paidCostDelta` (addCost) sets `{ kind: "unattributed" }`** — deliberately model-less, and distinguishable on the wire from provenance-missing:

```ts
export function paidCostDelta(amount: number): InvocationUsageDelta {
  if (!isValidCost(amount)) {
    throw new Error(`paidCostDelta: amount must be a finite, nonnegative number (got ${amount})`);
  }
  return { pricedCost: amount, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0,
           attribution: { kind: "unattributed" } };
}
```

**`normalizeUsageDelta` (untrusted IPC) validates `attribution`** — an invalid or absent attribution stays `undefined` (provenance-unknown; the IPC handler will flag it). Existing defensive cost/token behavior unchanged:

```ts
function normalizeAttribution(raw: unknown): UsageAttribution | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  if (a.kind === "unattributed") return { kind: "unattributed" };
  if (a.kind === "model" && typeof a.model === "string" && a.model.length > 0) {
    return { kind: "model", model: a.model };
  }
  return undefined;
}
// ...in normalizeUsageDelta: attribution: normalizeAttribution(obj.attribution)
```

**`recordUnknownCostAttempt`** (in `recordPaidUsage.ts`) leaves `attribution` absent — but its delta is not measurable (zero cost/tokens), so it never creates a row and never trips the incompleteness signal.

### 2. `lib/runtime/modelIdentity.ts` (new) + `lib/runtime/recordPaidUsage.ts` — model identity + completion accounting

- New tiny single-purpose module `resolveCompletionModel`:

```ts
/** The billing aggregation key for a completion: provider-reported model first,
 *  else the requested/configured model, else the literal "unknown model".
 *  Used verbatim (no provider-name normalization). A real model named
 *  "unknown model" is an ordinary key, never treated as unattributed. */
export function resolveCompletionModel(
  completionModel: string | null | undefined,
  configuredModel: string | null | undefined,
): string {
  return completionModel || configuredModel || "unknown model";
}
```

- `accountCompletionUsage(ctx, targetStack, completion)` gains a `model: string` parameter and passes it into `completionUsageDelta`. `recordUnknownCostAttempt` is unchanged. No other boundary logic changes.

### 3. `lib/runtime/prompt.ts` — use the helper at the completion site

Replace the inline `completion.model || clientConfig.model || "unknown model"` at `prompt.ts:732` with `resolveCompletionModel(completion.model, clientConfig.model)`, and pass the result to `accountCompletionUsage` at `prompt.ts:773`:

```ts
const modelName = resolveCompletionModel(completion.model, clientConfig.model);
// ...
accountCompletionUsage(ctx, targetStack, completion, modelName);
```

(`modelName` keeps feeding `updateTokenStats` as before — behavior is byte-identical, only refactored behind the helper so the precedence is unit-testable.)

### 4. `lib/runtime/costTelemetry.ts` — carry attribution on the wire; relay attribution-incomplete

- Add `attribution?: UsageAttribution` to `IpcInvocationUsageMessage`. `sendInvocationUsageToParent` already spreads the whole delta, so `attribution` rides along; the all-zero skip is unchanged. Verify the spread still includes `attribution`.
- Add a marker message and sender mirroring the existing incomplete-usage pair:

```ts
export type IpcModelAttributionIncompleteMessage = { type: "modelAttributionIncomplete" };

export function sendModelAttributionIncompleteToParent(): void {
  if (!canSend()) return;
  trySend({ type: "modelAttributionIncomplete" });
}
```

Add it to the `IpcUsageMessage` union.

### 5. `lib/runtime/recordPaidUsage.ts` (+ `ipc.ts`) — raise attribution-incomplete when provenance is missing

- New boundary helper, mirroring `markInvocationUsageIncompleteAt`:

```ts
export function markModelAttributionIncompleteAt(ctx: RuntimeContext<GraphState>): void {
  if (ctx.invocationUsage.markModelAttributionIncomplete()) {
    sendModelAttributionIncompleteToParent();
  }
}

/** True when a delta carries priced cost or tokens (i.e. it will create a row). */
export function isMeasurableDelta(d: InvocationUsageDelta): boolean {
  return d.pricedCost !== 0 || d.inputTokens !== 0 || d.outputTokens !== 0;
}
```

- **The single detection rule, applied to every child-received delta** (not to locally-built ones, which always carry attribution): a measurable delta with **no** `attribution` means an older child lost the model. Both IPC receive paths route through one helper so the rule lives in one place:

```ts
function accountChildUsageWithProvenance(s: RunSession, delta: InvocationUsageDelta): void {
  if (isMeasurableDelta(delta) && delta.attribution === undefined) {
    markModelAttributionIncompleteAt(s.ctx);
  }
  accountChildUsage(s, delta);   // -> recordPaidUsageAt -> meter.merge (buckets to unattributed)
}
```

- `handleInvocationUsageMessage` (`ipc.ts:976`) — build the normalized delta (now carrying `attribution`) and call `accountChildUsageWithProvenance`. A current-runtime child sends `{kind:"model"}`/`{kind:"unattributed"}` and does **not** trip the flag; a #801 child sends no attribution and **does** trip it.
- `handleTelemetryMessage` (`ipc.ts:969`) — the legacy `{costUsd}` delta has no attribution and is measurable when payable, so routing it through `accountChildUsageWithProvenance` trips the flag by the same rule (no special-casing).
- Add a dispatch case (`ipc.ts:1141` area) for the `modelAttributionIncomplete` marker that calls `markModelAttributionIncompleteAt(s.ctx)` — this propagates a grandchild's degraded attribution one hop further.

### 6. `lib/serve/http/adapter.ts` — no logic change

`RouteResult.usage` is typed `InvocationUsageSnapshot["usage"]` and `withUsage` copies the whole `usage` object (`adapter.ts:133`). The new `models` / `unattributed` / `modelAttributionComplete` fields live inside `usage`, so they flow to the host with no adapter code edit. Confirm the type still lines up.

### 7. `lib/runtime/state/context.ts` — no change

The meter is created fresh per invocation (`:402`) and never serialized; the new fields inherit that lifecycle.

---

## Why `modelAttributionComplete` is not cuttable

An earlier draft treated this axis as optional, on the theory that a hosted `run()` child loads the same runtime as its parent and so always sends a model. That theory is too weak to drop the axis on: the **immediately-preceding #801 runtime emits `invocationUsage` deltas with no attribution field at all**, and the legacy `{costUsd}` handler (`ipc.ts:969`) is live. During any rollout where a parent on this version can receive telemetry from a child on #801 (or an exotic `pkg::`-vendored older runtime), real LLM spend would be booked to `unattributed` with no signal. The only way to remove the axis would be to *reject* any child that omits the attribution discriminator — a harsher, less compatible choice than reporting the degradation. So the axis stays, and it reuses the existing `usageComplete` relay pattern rather than inventing a parallel mechanism.

---

## Testing

All deterministic, **no LLM calls** — the meter, delta helpers, and IPC handlers are exercised directly.

### `lib/runtime/invocationUsage.test.ts` — meter + delta

1. `completionUsageDelta` with a model → merged delta produces `models[model]` with the cost/tokens; flat totals equal the row.
2. Two different models → two rows; tokens reconcile with `===`; cost reconciles within `usageReconcileTolerance(pricedCost)`.
3. `paidCostDelta` (`{kind:"unattributed"}`) → lands in `unattributed`, not in `models`; reconciles.
4. Completion + addCost in one meter → a real model row **and** a nonzero `unattributed`; reconciles.
5. Pure unknown-cost delta → no model row, no `unattributed` row; `unknownCostCallCount` bumped; `pricingComplete === false`; `modelAttributionComplete` stays true.
6. Null-prototype safety: `model === "__proto__"` becomes a plain own key, no prototype pollution.
7. **Repeated deltas for one model aggregate into one row** (not duplicated).
8. **Interleaved charges that regroup differently:** merge `[a:0.1, b:0.1, a:0.1, b:0.1, a:0.1, b:0.1, a:0.1]` (this exact sequence gives flat `0.7`, row-sum `0.7000000000000001`). Assert `rowSum !== usage.pricedCost` AND within `usageReconcileTolerance` — proves the tolerance is load-bearing and guards against a later `===`.
9. **A real model literally named `"unknown model"`** is an ordinary `models` row, never `unattributed`.
10. `snapshot()` returns copies: mutating a returned row, or adding/deleting a `models` key, does not affect a later snapshot.
11. `modelAttributionComplete` is true by default and after ordinary completions + addCost; `markModelAttributionIncomplete()` flips it once and is idempotent.
12. **Negative reconciliation:** hand-corrupt one `models` row by an amount above the tolerance and assert the reconciliation check fails — proves the check has teeth (catches a real dropped charge, not just ulps).

### `lib/runtime/invocationUsage.test.ts` — `normalizeUsageDelta` / attribution

13. `{kind:"model", model:"opus"}` preserved; `{kind:"unattributed"}` preserved; a malformed/absent attribution → `undefined` (provenance-unknown). Existing cost/token defensive cases keep passing with `attribution` asserted.

### `lib/runtime/modelIdentity.test.ts` — identity precedence (new)

14. `resolveCompletionModel` returns the completion model when present; falls back to the configured model when the completion model is empty/absent; returns `"unknown model"` when both are absent. All three branches, directly.

### `lib/runtime/costTelemetry.test.ts` — SEND side (existing file)

15. Stub `process.send`; `sendInvocationUsageToParent` for a completion delta emits `attribution:{kind:"model",model}`; for an addCost delta emits `attribution:{kind:"unattributed"}`. Proves the field actually rides the wire (the receive tests below cannot).

### `lib/runtime/ipc.test.ts` — relay + provenance (existing `makeSession`/`ctx`)

16. `invocationUsage` message with `attribution:{kind:"model","opus-4.8"}` → parent has an `opus-4.8` row; `modelAttributionComplete` stays true.
17. `invocationUsage` message with `attribution:{kind:"unattributed"}` → parent `unattributed` grows; `modelAttributionComplete` stays true.
18. **#801-skew:** measurable `invocationUsage` message with NO `attribution` → parent books it to `unattributed` **and** `modelAttributionComplete === false`. (The case a plain `model` scalar missed.)
19. Legacy `telemetry` `{costUsd}` with payable cost → `unattributed` grows **and** `modelAttributionComplete === false`.
20. `modelAttributionIncomplete` marker from a child → parent `modelAttributionComplete === false`.
21. **Two-hop:** a modeled `invocationUsage` and, separately, a `modelAttributionIncomplete` marker each survive grandchild → child → parent (drive the parent-facing dispatch entry point twice).
22. **Concurrency:** two independent `RunSession` meters do not share `models` rows.

### `lib/serve/http/serveCostSeam.integration.test.ts` — snapshot surfacing + outcomes

23. Source-based end-to-end: an exported function charging via `addCost` → `result.usage.unattributed.pricedCost` equals the charge; reconciles to `result.usage.pricedCost`; `modelAttributionComplete === true`.
24. **Thrown outcome:** a function that charges then throws → the thrown route result still carries the breakdown (not dropped on the error path).
25. **Interrupt outcome:** an exported node that interrupts → the interrupt route result carries the breakdown. Resume goes through `respondToInterruptsForServe`, which snapshots the same meter; add a resume assertion if the file lacks one. Do not leave interrupt/resume only in prose — assert at least the interrupt result here.

---

## Documentation

Update `docs/dev/hosted-agent-execution.md` (serve cost seam section): the `models` / `unattributed` fields, the reconciliation tolerance, the three completeness axes and how they differ, and the model-identity contract. Touch `docs/dev/async-context.md` only if it describes the delta shape. **Do not** edit `docs/site/**` (user-facing docs are out of scope for a feature PR).

---

## Consumer handoff (statelog Group 4)

The host reads, inside `RouteResult.usage`:

- `models: Record<model, { pricedCost, inputTokens, outputTokens }>` — real models only.
- `unattributed: { pricedCost, inputTokens, outputTokens }` — model-less runtime spend (memory/image).
- `modelAttributionComplete: boolean` — when false, some priced spend in `unattributed` is degraded (a lost model), not genuinely model-less.

Rules for the host:

- Bill `usage.pricedCost` (authoritative). Treat the breakdown as attribution reconciling within `usageReconcileTolerance(pricedCost)` = `max(USAGE_RECONCILE_ABS_USD, USAGE_RECONCILE_REL * |pricedCost|)`; use that same function.
- **Rollout / absence:** these fields are optional. An **absent** `models`/`unattributed` means an older runtime emitted the snapshot — it does **not** mean zero spend. The host must fall back to the flat totals and record "breakdown unavailable," never zero. A present breakdown with `modelAttributionComplete === false` means real spend sits in `unattributed` because a child's model was lost — attribute it as "unknown model," not as runtime overhead.
- Honor `pricingComplete` and `usageComplete` exactly as today; they apply to the rows as they apply to the totals. Add `modelAttributionComplete` as the third, independent signal.
- Requires a matching agency-lang release and a statelog pin bump, same as the base seam.

---

## Out of scope (explicitly not v1)

- Per-model attribution of unknown-cost attempts (`unknownCostCallCount` stays invocation-level).
- Cache-read / cache-write token breakdown per model (the meter tracks neither today).
- Surfacing the breakdown over the MCP adapter or the CLI serve path — only the HTTP `RouteResult` carries usage today, and only the HTTP host consumes it.
- Any change to `__tokenStats.models`, the `/cost` footer, or the existing flat-total accumulation (#801 semantics are untouched).
