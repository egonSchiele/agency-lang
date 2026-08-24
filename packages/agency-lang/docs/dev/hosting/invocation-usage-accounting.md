# Invocation usage accounting (the serve cost seam)

A hosted invocation must report the complete money-and-token breakdown it
incurred, so `statelog` can bill it and show per-model spend. This note covers
how a charge travels from a provider result to that breakdown, and how the
breakdown survives a subprocess boundary.

## The two figures

Every invocation carries two things that must not be confused:

- **The authoritative flat total**: `usage.cost` (a full `CostBreakdown`) and
  `usage.tokens` (a full `TokenBreakdown`). This is what gets billed. It is
  always trusted as long as `usageComplete` is true.
- **The best-effort attribution**: `usage.entries`, one entry per `(kind,
  model)`. This is a convenience for "which model cost what". It is reconciled
  against the flat total only when telemetry is complete. The flat total is
  never derived from summing entries.

`kind` is the API verb. `ProviderUsageKind` is
`"completion" | "embedding" | "image" | "transcription" | "speech"`, and
`UsageKind` adds `"manual"`. A `"manual"` charge comes from `addCost()` and its
`model` is the sentinel `""`, never null, so a database
`UNIQUE(invocation_id, kind, model)` works without `NULLS NOT DISTINCT`.
Provider kinds always carry a non-empty model.

Two independent completeness axes ride alongside:

- `usage.pricingComplete === (usage.unknownCostCallCount === 0)`. Did every
  call arrive with a usable USD price? A call with no price still counts its
  tokens, and only bumps `unknownCostCallCount`.
- `usageComplete`, a SIBLING of `usage` rather than a nested field. Did all
  telemetry arrive? A killed subprocess or a degraded IPC recovery flips this
  false, which makes the whole figure a trusted LOWER BOUND.

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
  `unknownCostCallCount` bumps, even if the named components look fine.
  `totalCost: 0` is known-free, so it counts as priced rather than unknown.
- **Named cost components are best-effort.** Each is copied only if it is a
  finite nonnegative number; absent/negative/NaN/±Infinity → 0. They are never
  reconciled to `totalCost`.
- **`totalTokens` is authoritative when present and valid.** When it is absent,
  `fallbackTotalTokens` uses a kind-specific sum. Completion adds all four
  counters. Every other kind adds only input plus output, because their cache
  counters may OVERLAP input, so summing them would double-count. A
  present-but-malformed `totalTokens` uses the fallback AND sets
  `attributionLost`, which makes the snapshot a lower bound.
- **Audio tokens collapse into `totalTokens`** and never surface as their own
  fields. An authoritative provider total already includes them. Only in the
  fallback branch does `buildTokens` widen the lower bound to
  `max(text-sum, audio-sum)`, and the presence of audio counters without an
  authoritative total sets `attributionLost`.
- `projectProviderTokenUsage(raw, kind)` is the ONE closed projection of a
  provider's raw token usage. The meter, the branch total `stack.localTokens`,
  the global token stats, and every statelog payload all run raw usage through
  it, so they agree on the total by construction.
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
4. relay the delta upward with `sendInvocationUsageToParent`. Only on a first
   meter transition, send one `invocationUsageIncomplete` marker AFTER it. FIFO
   ordering then preserves the recovered money before the ancestor degrades.

Public entry points: `recordUsage` (normalizes an observation),
`recordUnresolvedAttempt`, `recordNormalizedUsageDelta` (the IPC path — does NOT
re-normalize and does NOT enforce guards), `recordCompletionUsage` (prompt.ts —
also does the branch-local `localTokens` compatibility update),
`meteredDispatch` (runs a provider dispatch, records one attempt on rejection,
returns the promise UNCHANGED so it adds no microtask tick), and
`markInvocationUsageIncompleteAt`. `addCost` in `cost.ts` validates
finite-nonnegative first, throwing `addCost: amount must be a finite,
non-negative number` otherwise. It then records a `manual` observation and
enforces guards.

Sources wired in:

- `prompt.ts` and `llmDispatch.ts` — completion.
- `memory/manager.ts` — completion and embedding. It no-ops without an ALS
  frame, and it re-raises guard errors.
- `lib/stdlib/image.ts` — records cost and tokens for BOTH a returned image and an
  empty result, because the provider charged either way. It emits the
  `imageGeneration` event only when there is an image.
- `lib/stdlib/speech.ts` — the `transcription` and `speech` kinds. See
  [`speech-via-smoltalk.md`](../llm/speech-via-smoltalk.md).

## Across the subprocess boundary — `costTelemetry.ts` / `ipc.ts`

The child sends `{ type: "invocationUsage", ...delta }` (the full nested
`NormalizedDelta`) fire-and-forget, and suppresses an all-zero delta. The parent
receives an UNTRUSTED shape, runs `normalizeIpcUsageDelta`, then feeds the
recovered delta to `recordNormalizedUsageDelta` and enforces live-session
guards. All of that is synchronous, with no `await` between accounting and
settlement, because the FIFO ordering of telemetry before the terminal message
depends on it. A mid-tier process re-relays
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
breakdown, and passing both groups per pair. The rows sort by cost descending,
then model, then kind. Totals gain a `≥` prefix when EITHER completeness flag
is false. This side pairs with
the companion statelog schema; ship the two repos as a pinned pair.
