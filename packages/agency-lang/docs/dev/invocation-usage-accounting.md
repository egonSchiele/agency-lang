# Invocation usage accounting (the serve cost seam)

A hosted invocation must report the complete money-and-token breakdown it
incurred, so `statelog` can bill it and show per-model spend. This note covers
how a charge travels from a provider result to that breakdown, and how the
breakdown survives a subprocess boundary.

## The two figures

Every invocation carries two things that must not be confused:

- **The authoritative flat total** — `usage.cost` (a full `CostBreakdown`) and
  `usage.tokens` (a full `TokenBreakdown`). This is what gets billed. It is
  always trusted as long as `usageComplete` is true.
- **The best-effort attribution** — `usage.entries`, one entry per `(kind,
  model)`. This is a convenience for "which model cost what". It is reconciled
  against the flat total only when telemetry is complete; the flat total is
  never derived from summing entries.

`kind` is the API verb: `"completion" | "embedding" | "image" | "manual"`.
`"manual"` is an `addCost()` charge; its `model` is the sentinel `""` (never
null, so a database `UNIQUE(invocation_id, kind, model)` works without
`NULLS NOT DISTINCT`). Provider kinds always carry a non-empty model.

Two independent completeness axes ride alongside:

- `usage.pricingComplete === (usage.unknownCostCallCount === 0)` — did every
  call arrive with a usable USD price? A call with no price still counts its
  tokens; it just bumps `unknownCostCallCount`.
- `usageComplete` (a SIBLING of `usage`, not nested) — did all telemetry arrive?
  A killed subprocess or a degraded IPC recovery flips this false, making the
  whole figure a trusted LOWER BOUND.

## The value layer — `lib/runtime/invocationUsage.ts`

Pure, no I/O. Three domain observations feed one normalizer:

```ts
type UsageObservation =
  | { type: "provider"; kind; reportedModel?; configuredModel?; cost?; tokens? }
  | { type: "attempt"; kind }          // dispatched, never resolved to a price
  | { type: "manual"; amount };        // addCost()
```

`normalizeObservation(obs)` returns a `NormalizedDelta`. The rules that are easy
to get wrong:

- **A price is valid only when `totalCost` is finite-nonnegative AND
  `currency === "USD"`.** Otherwise all six cost fields become zero and
  `unknownCostCallCount` bumps — even if the named components look fine.
  `totalCost: 0` is known-free (priced), not unknown.
- **Named cost components are best-effort.** Each is copied only if it is a
  finite nonnegative number; absent/negative/NaN/±Infinity → 0. They are never
  reconciled to `totalCost`.
- **`totalTokens` is authoritative when present and valid.** When it is absent,
  fall back to a kind-specific sum: completion adds all four counters;
  embedding/image add only input+output, because their cache counters may
  OVERLAP input (never sum them). A present-but-malformed `totalTokens` uses the
  fallback AND sets `attributionLost` (the snapshot is now a lower bound).
- All count arithmetic is checked-add saturating at `Number.MAX_SAFE_INTEGER`;
  a saturation degrades `usageComplete`.

`InvocationUsageMeter` accumulates deltas. `merge(delta)` returns `true` ONLY on
the first count-overflow transition to incomplete, so a caller relays exactly
one upward marker. Attribution buckets live in a nested null-prototype index
`Record<UsageKind, Record<string, number>>` pointing into the first-seen
`entries` array (no composite string key). `snapshot()` deep-copies.

`normalizeIpcUsageDelta(raw)` is the untrusted-input twin: it recovers every
independently-valid field, omits an unusable entry while KEEPING the flat money,
sets `attributionLost`, and returns `null` only when the whole message is not an
object. It never silently drops money.

## The one sink — `lib/runtime/recordPaidUsage.ts`

`recordUsageDelta` (private) is the single place a delta is accounted:

1. `stack.billCharge(delta.cost.totalCost)` — localCost + guard accumulators (no
   throw).
2. `ctx.invocationUsage.merge(delta)` — once.
3. if `delta.attributionLost`, `markIncomplete()`.
4. relay the delta upward, THEN (only on a first meter transition) one
   `invocationUsageIncomplete` marker AFTER it — FIFO preserves the recovered
   money before the ancestor degrades.

Public entry points: `recordUsage` (normalizes an observation),
`recordUnresolvedAttempt`, `recordNormalizedUsageDelta` (the IPC path — does NOT
re-normalize and does NOT enforce guards), `recordCompletionUsage` (prompt.ts —
also does the branch-local `localTokens` compatibility update),
`meteredDispatch` (runs a provider dispatch, records one attempt on rejection,
returns the promise UNCHANGED so it adds no microtask tick), and
`markInvocationUsageIncompleteAt`. `addCost` (`cost.ts`) validates
finite-nonnegative first (else throws `addCost: amount must be a finite,
non-negative number`), records a `manual` observation, then enforces guards.

Sources wired in: `prompt.ts` (completion), `memory/manager.ts` (completion +
embedding, no-ops without an ALS frame, re-raises guard errors), `stdlib/image.ts`
(records + tokens for BOTH a returned image and an empty result — the provider
charged either way — but emits the `imageGeneration` event only when there is an
image).

## Across the subprocess boundary — `costTelemetry.ts` / `ipc.ts`

The child sends `{ type: "invocationUsage", ...delta }` (the full nested
`NormalizedDelta`) fire-and-forget; an all-zero delta is suppressed. The parent
receives an UNTRUSTED shape, runs `normalizeIpcUsageDelta`, then feeds the
recovered delta to `recordNormalizedUsageDelta` and enforces live-session guards
— all synchronous, no `await` between accounting and settlement (FIFO ordering
of telemetry-before-terminal-message depends on it). A mid-tier process re-relays
what it received, so grandchild spend reaches the root with no explicit plumbing.

### #809 boundary

Only a REJECTED provider promise counts as an unresolved attempt. A resolved
`Result.failure` records nothing, because smoltalk cannot yet distinguish a
pre-dispatch failure (no spend) from a post-dispatch one (real spend). Closing
that gap is deferred to agency-lang #809.

## The spend CLI — `lib/cli/statelog/spendTypes.ts` and friends

`ProjectSpend` mirrors the invocation breakdown: `cost`, `tokens`,
`invocationCount`, `unpricedCallCount`, `pricingComplete`, `usageComplete`, and a
`breakdown: ModelKindSpend[]`. Strict Zod schemas own every invariant and the
TS types are inferred from them, so the sealed `ProjectClient.getSpend` /
`AccountClient.getAccountSpend` return types cannot drift from their validators.
`agency remote spend [project]` renders it; `--by-model` / `--by-kind` group the
breakdown (both → per pair), sorted by cost desc then model then kind. Totals
gain a `≥` prefix when EITHER completeness flag is false. This side pairs with
the companion statelog schema; ship the two repos as a pinned pair.
