# Full Cost & Token Breakdown, Per Model — Design (agency + statelog)

> Spans **agency-lang** (produce + propagate) and **statelog** (store + aggregate).
> The hosted **spend ledger** has no consumers yet, so its schema is a clean
> breaking change. But several *runtime* surfaces (below) do have users and are
> kept. Rev 3 — rewritten to address the two design reviews; the accounting
> contract is the point of this document, so it is specified here, not deferred
> to the plan.

## Goal

Capture, per hosted invocation, the complete cost and token information smoltalk
produces — input / output / cached-read / cache-write / hosted-tools costs, and
input / output / cached-read / cache-write / total tokens — attributed per model
and per API verb, with a **single authoritative billing total** that the
attribution breakdown reconciles to but never redefines.

## What smoltalk gives us

`completion.cost` / `.usage` (also on embed and image results) —
`smoltalk/dist/types/{costEstimate,tokenUsage}.d.ts`:

```ts
CostEstimate = { inputCost, outputCost, cachedInputCost?, cacheCreationInputCost?, hostedToolsCost?, totalCost, currency }
TokenUsage   = { inputTokens, outputTokens, cachedInputTokens?, cacheCreationInputTokens?, totalTokens? }
```

- smoltalk computes `totalCost` from the components and rounds each to 6 dp
  (`model.js`), so `totalCost` is the authoritative figure and the components may
  miss it by sub-microdollar rounding.
- `hostedToolsCost` has **no** token counterpart.
- `totalTokens` is provider-authoritative; the four token counters **may
  overlap** depending on source (completion clients normalize cached vs ordinary
  input into disjoint buckets; the image path can report `cachedInputTokens` as a
  *subset* of `inputTokens`). Never derive a total by summing the four.
- `currency` is `"USD"` from every current provider.

Every internal source already holds this and discards all but `.totalCost`:
agent turns (`prompt.ts:773`), memory text — extraction/compaction/recall — and
memory embeddings (`memory/manager.ts:292,370`), image gen (`image.ts:96`); only
the public `addCost(amount)` (`cost.ts:15`) is a bare scalar.

## Core model: three observations → one boundary → authoritative totals + reconciled attribution

Call sites never build dense breakdown objects or decide completeness. They emit
one of three **domain observations**; one normalization layer turns each into an
internal delta; one boundary bills guards, merges the meter, and relays once.

```ts
type ProviderUsageKind = "completion" | "embedding" | "image";   // provider calls; always have a model
type UsageKind = ProviderUsageKind | "manual";                   // stored kind

type UsageObservation =
  // reportedModel/configuredModel go to central resolution — call sites don't pick the model
  | { type: "provider"; kind: ProviderUsageKind; reportedModel?: string | null; configuredModel?: string | null; cost?: CostEstimate; tokens?: TokenUsage }
  | { type: "attempt"; kind: ProviderUsageKind }  // a provider request dispatched but not resolved
  | { type: "manual"; amount: number };           // a program-declared addCost cost

recordUsage(target, observation): void;   // the one PUBLIC boundary → normalize → recordUsageDelta
```

The union makes impossible states unrepresentable: only a `provider`/`attempt`
observation carries a `ProviderUsageKind`, and only the `manual` builder produces
`{ kind:"manual" }`. Malformed IPC input is NOT this trusted union — it is a
separate normalized transport delta with optional fields (IPC section).

The four provider outcomes are resolved **once, centrally** (not per call site):

1. **Success, valid price** (`cost` present, finite, USD) — priced; build the entry.
   `totalCost === 0` is a *known free* price (no counter bump).
2. **Success, no/invalid/non-USD price** — keep `model` + `tokens` as an entry
   with zero cost, increment `unknownCostCallCount`, `pricingComplete` becomes
   false. Never invent a cost.
3. **Dispatched-but-unresolved attempt** (`type:"attempt"`) — no entry,
   increment `unknownCostCallCount` (→ `pricingComplete=false`); `usageComplete`
   stays true (the attempt was observed reliably). Each retry is a fresh attempt.
   **Applies to completion, embedding, and image alike.**
   > **Known limitation — tracked by agency-lang #809.** `LLMClient.{text,embed,
   > image}` return `Promise<Result<…>>`, and a `Result.failure` covers **both** a
   > pre-dispatch failure (no spend) and a post-dispatch one (possible spend),
   > indistinguishably. So for now agency counts an attempt only on a **rejected
   > promise** (today's `meteredDispatch` behavior); a resolved `Result.failure`
   > is not yet counted. The real fix is smoltalk exposing whether the request was
   > dispatched (#809), after which we count exactly the dispatched-but-failed
   > calls. Do not implement "count every resolved failure" — it over-flags
   > pre-dispatch failures.
4. **Proven pre-dispatch failure** — no observation at all.

**Exactly once.** Each successful paid operation submits exactly one `provider`
observation and nothing else. Memory and image **replace** their `addCost(total)`
call with a `provider` observation (they must not do both, or they double-charge).
`manual` is reserved for user-declared / external costs via the public `addCost`.

## Cost & token value types

```ts
// `totalCost` is AUTHORITATIVE. The five named components are smoltalk's split —
// a BEST-EFFORT estimate that MAY NOT sum to totalCost (a manual/total-only charge
// has all components 0 and total = the amount; rounding also means a provider
// split may miss the total by a sub-microdollar). No reconciliation invariant on
// components, and no residual/"unallocated" field. Consumers wanting a split use
// the components; anyone billing uses totalCost.
type CostBreakdown = {
  inputCost; outputCost; cachedInputCost; cacheCreationInputCost; hostedToolsCost; totalCost;
  currency: "USD";
};

// totalTokens is AUTHORITATIVE (provider value, else kind-specific fallback — see
// below). The four counters are as smoltalk reports them and MAY overlap;
// consumers must use totalTokens for the total, never the sum.
type TokenBreakdown = {
  inputTokens; outputTokens; cachedInputTokens; cacheCreationInputTokens; totalTokens;
};

// model is a plain string — "" is the sentinel for a manual charge (never null),
// so a DB UNIQUE(invocation_id, kind, model) actually catches duplicates.
type UsageEntry = { kind: UsageKind; model: string; cost: CostBreakdown; tokens: TokenBreakdown };
```

**Token total fallback is kind-specific** (a single `input+output` formula is
wrong for cached completions and double-counts images): use the provider
`totalTokens` when present; else **completion** = input + output + cache-read +
cache-write (the completion adapter normalizes those into disjoint buckets);
**embedding**/**image** = input + output (image cache counts may be a subset of
input). All counts are non-negative safe integers.

**Currency: USD-only.** The boundary asserts `currency === "USD"` on a priced
observation; a non-USD price is treated as case 2 (unpriced) rather than summed
into a USD total. `currency:"USD"` is carried through runtime, wire, DB, API, and
display. (Multi-currency would require grouping every total by currency — out of
scope; no provider needs it.)

**Model identity.** Central resolution only: the normalizer runs
`resolveCompletionModel(reportedModel, configuredModel)` (provider → configured →
`"unknown model"`) for every provider observation, so a real provider entry
always has a non-empty model. Call sites never pick the model. `model` is `""`
only for a `manual` entry. Memory's `_text` path (extraction, compaction, recall)
is a `completion`; its embeddings are `embedding` — the model disambiguates them.

## The snapshot — authoritative totals + attribution, with `usageComplete` a sibling

```ts
type InvocationUsage = {
  cost: CostBreakdown;         // AUTHORITATIVE flat totals, accumulated in call order (the billed figure)
  tokens: TokenBreakdown;      // AUTHORITATIVE flat totals
  unknownCostCallCount: number;
  pricingComplete: boolean;    // === (unknownCostCallCount === 0)
  entries: UsageEntry[];       // reconciled attribution, one per (kind, model); NOT the billing source
};

type InvocationUsageSnapshot = {
  usage: InvocationUsage;
  usageComplete: boolean;      // SIBLING of usage (unchanged from #801): telemetry delivery / lower-bound flag
};
```

- **Authoritative vs attribution.** `usage.cost.totalCost`/`usage.tokens.totalTokens`
  are the truth (accumulated per charge in call order, #801-style). `entries` are a
  BEST-EFFORT attribution: `sum(entries.cost.totalCost) ≈ usage.cost.totalCost`
  within `usageReconcileTolerance` **only when telemetry is complete**. The
  individual cost *components* carry no reconciliation guarantee. A discrepancy
  never changes a billed total, and a `usageComplete=false` snapshot keeps and
  surfaces its authoritative totals even when entries do not reconcile — downstream
  persistence must not reject it for that.
- **`usageComplete` stays a sibling** (not nested in `usage`) — the HTTP
  adapter/outcome/route contract already carry it there, so **Part 1's adapter
  needs no change** (it copies `usage` + `usageComplete`).
- **Retired** vs #802: `pricedCost` scalar (→ `usage.cost.totalCost`), the
  `models` map + `unattributed` field (→ `entries`), `modelAttributionComplete`
  and the version-skew machinery (dropped: no ledger consumers, and a `run()`
  child shares the parent's version).

## IPC: preserve valid money, degrade completeness — never silently drop

`normalizeUsageDelta` (untrusted process-boundary input) validates each field
independently: invalid cost → an unknown-cost attempt (never a known-free zero),
keeping valid tokens; counts coerced to nonnegative safe integers. **A delta
carrying real money that cannot be fully attributed (e.g. an unusable `kind`) is
still counted in the authoritative flat totals, gets no attribution entry, and
sets `usageComplete = false` (relayed upward).** Only a wholly unparseable
message (not an object) is dropped, and it carries nothing to preserve. Money is
never lost while `usageComplete` stays true. (This is why removing
`modelAttributionComplete` is safe: lost attribution degrades `usageComplete`.)

---

# Part 1 — agency-lang (producer + transport)

- **`lib/runtime/invocationUsage.ts`** — `CostBreakdown`, `TokenBreakdown`,
  `UsageKind`, `UsageEntry`, the new `InvocationUsage`/snapshot; the observation→
  delta normalizer (the four cases + central model resolution + USD + kind-specific totalTokens
  derivation); `InvocationUsageMeter` owns validation, `(kind,model)` bucketing,
  call-order flat accumulation, copy-on-snapshot, and reconciliation. Delete the
  `models`/`unattributed`/`modelAttributionComplete` machinery.
- **`lib/runtime/recordPaidUsage.ts`** — ONE private sink
  `recordUsageDelta(target, normalizedDelta)` does, synchronously and in order:
  (1) `billCharge(cost.totalCost)`; (2) merge authoritative flat fields + any valid
  entry; (3) relay the delta upward once. Public `recordUsage(ctx, stack,
  observation)` normalizes a trusted observation then calls the sink; IPC (Task 4)
  independently normalizes untrusted fields then calls the **same** sink. Do **not**
  claim end-to-end "exactly once" transport — `process.send` is fire-and-forget with
  no ack; the enforceable invariant is one relay attempt per locally recorded delta,
  plus `usageComplete=false` on abnormal child termination.
- **Sources** feed observations (each **replacing** its old scalar charge, exactly
  once, preserving existing ordering): `prompt.ts:773` accounts the completion where
  it does today (before memory hooks; enforcement stays in the surrounding flow, NOT
  moved into `recordUsage`); `memory/manager.ts:292` → `completion`, `:370` →
  `embedding` (the new helper keeps `chargeCostIfInFrame`'s no-op-without-a-frame and
  guard-rethrow behavior); `image.ts:96` → `image`, recording on the successful
  provider result (even when `images[0]` is absent — the spend already happened) and
  keeping branch-token accounting + the cost-last guard-trip ordering.
- **`cost.ts` `addCost(amount)`** (public, kept) — validates its argument
  up-front and **rejects a negative or non-finite amount with a clear,
  addCost-facing error** (today the throw is buried in `paidCostDelta` and names
  that internal helper), then emits `{manual, amount}`.
- **`costTelemetry.ts` / `ipc.ts`** — `IpcInvocationUsageMessage` carries the
  full delta; receive path normalizes as above (preserve money, degrade
  `usageComplete`). **Removed**: the legacy `{costUsd}` message + handler and the
  `modelAttributionIncomplete` marker.
- **`serve/http/adapter.ts`** — no logic change (`usage` + sibling
  `usageComplete` already copied).
- **`lib/cli/remote/*`** — `spendTypes.ts` + renderers updated to the new
  `ProjectSpend` (Part 2 / API section). Breaking; validated via zod so an
  incompatible host response fails with a clear error.

## Runtime compatibility inventory (surfaces that DO have users)

| Surface | Decision |
|---|---|
| `std::thread getCost()/getTokens()` (branch `localCost`/`localTokens`, `totalTokens`) | **Retained** — unaffected; `totalTokens` preserved |
| `getModelCosts()` / `__tokenStats` / `updateTokenStats` (`/cost` footer) | **Retained as-is** — Part 1.7 (per-model cost-type parity there) is **deferred**: changing `getModelCosts()` is a breaking stdlib-API change with real users, for marginal gain. It keeps its current process-cumulative shape. |
| `RunNodeResult.tokens` (= `__tokenStats`) | **Retained** (unchanged, since `__tokenStats` is) |
| serve `RouteResult.usage` | **Adapted (breaking)** — new shape; only consumer is the `agency remote spend` CLI, rewritten in lockstep |
| subprocess IPC usage message | **Adapted (breaking)** — new wire; runtime ships as one version |
| statelog spend API + validators, CLI JSON, fixtures | **Adapted (breaking)** — Part 2 |

---

# Part 2 — statelog (storage + query + API)

Two tables. The **parent is the authoritative billing fact**; the child is
attribution detail. (Replaces Group-4's single aggregate `usage_events`.)

All columns `NOT NULL` (a bare `CHECK (x >= 0)` still admits `NULL`); ids are
repo-native **text/`nanoid`**, not UUID; costs `numeric(20,10)` (exact for
smoltalk's 6-dp; max just under 10^10 — test overflow), tokens `bigint`.

```
hosted_invocations                    -- one per hosted invocation (the billing fact)
  id                     text PK                       -- nanoid
  execution_attempt_id   text NOT NULL UNIQUE          -- runtime occurrence id → idempotency key (host-minted nanoid)
  project_id             … FK → projects(id) ON DELETE RESTRICT   -- retention-safe: never cascade away billing
  trace_id               text NULL                     -- nullable: RouteResult carries no trace id today
  created_at             timestamptz NOT NULL DEFAULT now()   -- the spend-window timestamp
  input_cost … cache_creation_input_cost, hosted_tools_cost, total_cost  numeric NOT NULL DEFAULT 0 CHECK (>= 0)
  input_tokens … cache_creation_input_tokens, total_tokens               bigint  NOT NULL DEFAULT 0 CHECK (>= 0)
  currency               text NOT NULL CHECK (currency = 'USD')
  unknown_cost_call_count int NOT NULL DEFAULT 0 CHECK (>= 0)
  usage_complete         boolean NOT NULL
  -- pricing_complete is DERIVED (unknown_cost_call_count = 0) in the API, not stored

usage_events                          -- attribution detail; zero-or-more per invocation
  id            text PK                              -- nanoid
  invocation_id text NOT NULL FK → hosted_invocations(id) ON DELETE CASCADE
  kind          text NOT NULL CHECK (kind IN ('completion','embedding','image','manual'))
  model         text NOT NULL                        -- '' sentinel for manual (never NULL)
  input_cost … hosted_tools_cost, total_cost         numeric NOT NULL DEFAULT 0 CHECK (>= 0)
  input_tokens … total_tokens                        bigint  NOT NULL DEFAULT 0 CHECK (>= 0)
  currency      text NOT NULL CHECK (currency = 'USD')
  CHECK ( (kind = 'manual' AND model = '') OR (kind <> 'manual' AND model <> '') )
  UNIQUE (invocation_id, kind, model)   -- works because model is NOT NULL ('' for manual): one row per bucket
  INDEX (invocation_id), INDEX (model), INDEX (kind)
```

The `''`-sentinel + `NOT NULL` model is what makes `UNIQUE (invocation_id, kind,
model)` actually enforce one row per bucket — a plain unique over a nullable
`model` would let duplicate manual rows through (Postgres treats each `NULL` as
distinct), and it needs no PostgreSQL-version-specific `NULLS NOT DISTINCT`.

**Testability — a thin store over pure logic (no CI database needed).** All logic
is pure and unit-tested with plain objects; only a small `SpendStore` touches
Postgres, shaped so the fan-out bug cannot be written:
```ts
type SpendStore = {
  saveInvocation(parent: InvocationRow, details: UsageEventRow[]): Promise<void>; // one idempotent transaction
  sumInvocationTotals(projectId, from, to): Promise<InvocationTotals>;  // aggregates ONE table (parents)
  groupUsageEvents(projectId, from, to): Promise<UsageGroupRow[]>;      // aggregates ONE table (details)
};
// pure, DB-free:
function toInvocationRows(snapshot, ids): { parent: InvocationRow; details: UsageEventRow[] };
function assembleProjectSpend(totals: InvocationTotals, groups: UsageGroupRow[]): ProjectSpend;  // empties→0, pricingComplete, sort, breakdown
```
Because each store method aggregates **one table**, the dangerous "join parent to
detail then `SUM(parent)`" pattern (which multiplies the bill) is never expressible;
`assembleProjectSpend` just combines two already-aggregated small results. The
untested surface is three tiny SQL methods, coverable with an **in-memory Postgres
(`pg-mem`)** in unit tests — no CI DB service or containers.

**Recorder — `recordHostedInvocation(snapshot, ids)`** = `toInvocationRows` (pure)
+ `store.saveInvocation` (one transaction). Idempotency is **insert-or-read-and-
compare**, not blind `DO NOTHING`: on an existing `execution_attempt_id`, read the
stored parent and return `duplicate` only if the immutable payload (project + every
authoritative amount, compared after numeric normalization) matches; a **different
payload under the same key is a loud failure** (hides corruption otherwise). Signature:
no `trx` → open one `db.transaction()`; caller `trx` → run in it without nesting;
throw inside the callback on any detail failure so Kysely cannot commit a partial
parent; convert to `Result` only outside the transaction. Persistence stays
**best-effort** (the host logs a failure and still responds — an accepted rare
undercount, stated explicitly); making it blocking is a separate behavioral change.

**Aggregation — join-safe.** Two single-table aggregates combined purely
(`assembleProjectSpend`); the parent query **never** joins `usage_events`. For the
**account** rollup: (1) `projects LEFT JOIN hosted_invocations` (window predicates
in the JOIN) grouped by internal project id → one row per project incl. deleted &
zero-event; (2) a detail aggregate grouped by internal project id + `(model, kind)`;
(3) merge in app code keyed on **internal project id** (not the mutable slug), `[]`
breakdown for projects with no detail. Empty identity is explicit: all costs/tokens
`0`, counts `0`, both completeness flags `true`, `breakdown: []` (`SUM`/`bool_and`
return `NULL` on empty). Deterministic breakdown order (model asc, then kind).

The spec forbids `SUM(hosted_invocations.total_cost)` or `COUNT` after joining
detail rows (fan-out would multiply the billed total per detail row).

**API types (`apiTypes/spend.ts`, breaking replacement):**

```ts
type ProjectSpend = {
  cost: CostBreakdown;          // from parent totals (authoritative); currency lives HERE only
  tokens: TokenBreakdown;       // from parent totals
  invocationCount: number;
  unpricedCallCount: number;    // SUM(unknown_cost_call_count)
  pricingComplete: boolean;     // unpricedCallCount === 0
  usageComplete: boolean;       // bool_and(usage_complete)
  breakdown: ModelKindSpend[];  // GROUP BY (model, kind)
};
type ModelKindSpend = { model: string; kind: UsageKind; cost: CostBreakdown; tokens: TokenBreakdown };  // model "" = manual
```

Routes/window unchanged (`/api/projects/:slug/spend`, `/api/spend`, epoch-ms
`[from,to)`). `ProjectSpend` is **replaced**, not extended — the CLI validates it
with zod and fails clearly against an incompatible host.

## CLI (`agency remote spend`) — fully specified

- Default: the authoritative totals — cost (with its component breakdown lines),
  token totals, invocationCount — plus trust markers.
- `--by-model` / `--by-kind`: render `breakdown` grouped by model / by kind
  (combinable → grouped by both). Sorted by `cost.totalCost` desc, tie-break
  `(model, kind)` ascending; a `model: ""` (manual) row is labelled `(manual)`.
- `--json`: the raw `ProjectSpend` verbatim (machine surface).
- Money via the adaptive formatter (`$0.0000` only for true zero, `<$0.0001`
  tiny); currency shown as `USD`.
- A total is a lower bound (`≥`) when **either** `usageComplete === false`
  (telemetry loss) **or** `pricingComplete === false` (unknown-priced calls) — with
  a separate one-line note for each axis;
  `unpricedCallCount > 0` → an unpriced-calls note. Empty window → `No spend in <window>.`
- Account rollup: one row per project (deleted projects marked, per the existing
  command), each carrying the same shape.

## Migration / rollout

A **new** migration drops Group-4's `usage_events` and creates
`hosted_invocations` + `usage_events` (do not edit applied migration history).
Explicit deployment assumption: no production spend data exists, so the policy is
drop-and-rebuild. Ship the agency-lang runtime and the statelog host as a **pinned
pair**; version skew between them is unsupported and fails clearly (zod
validation), not silently.

## Reconciliation & trust axes

- **Cost**: `totalCost` authoritative and billed. The five components are a
  **best-effort estimate with no sum-to-total invariant** (manual/total-only = 0
  components; rounding). The only reconciliation is at the attribution level and
  **only when telemetry is complete**: `sum(entries.cost.totalCost) ≈
  usage.cost.totalCost` within `usageReconcileTolerance`. A `usageComplete=false`
  snapshot keeps its authoritative totals even when entries don't reconcile.
- **Tokens**: `totalTokens` authoritative (kind-specific fallback when absent);
  component counters may overlap and are never summed for the total; all counts
  nonnegative safe integers.
- **Two completeness axes only**: `pricingComplete` (price availability, derived
  from `unknownCostCallCount`) and sibling `usageComplete` (telemetry delivery /
  lower-bound). `modelAttributionComplete` is gone.

## Decisions

1. `kind` = API verb (`completion|embedding|image|manual`). RESOLVED.
2. No version-skew defense; but **malformed IPC degrades `usageComplete`, it is
   not dropped** (money preserved in the authoritative total). RESOLVED.
3. Two tables; parent authoritative, child attribution; join-safe aggregation. RESOLVED.
4. **Cost components are best-effort** — no sum-to-total invariant, no residual/`unallocated` field; `totalCost` is the separate authoritative figure. `hostedToolsCost` has no token counterpart. RESOLVED.
5. `hostedToolsCost` carried. RESOLVED.
6. `numeric(20,10)` (exact for 6-dp; test overflow near 10^10).
7. Currency USD-only, asserted at the boundary, carried through. Single source: `CostBreakdown.currency` only — NOT duplicated at `ProjectSpend.currency`. RESOLVED.
8. `usageComplete` is a snapshot sibling, not nested. RESOLVED.
9. **`model` is a plain string; `""` is the manual sentinel** (never null) — makes the DB `UNIQUE(invocation_id, kind, model)` enforce one row per bucket without version-specific `NULLS NOT DISTINCT`. RESOLVED.
11. **Failed-call dispatch detection deferred to smoltalk** (agency-lang #809): count promise rejections now; resolved `Result.failure` later. RESOLVED.
12. **Statelog tested via a thin `SpendStore` over pure logic** (most tests DB-free); the store/migration integration tests run against **real PostgreSQL 16** locally and in CI (a CI Postgres service), superseding the earlier `pg-mem` suggestion. RESOLVED.
13. **Persistence best-effort** (log + respond, accept rare undercount); blocking is a separate change. RESOLVED.
10. Part 1.7 (`__tokenStats`/`getModelCosts` per-model cost-type parity) **deferred** — `getModelCosts` stays as-is (breaking a used stdlib API isn't worth it). RESOLVED.

## Testing

**agency**: the four provider outcomes (priced / priced-zero / unpriced / attempt)
for completion + embedding + image; `manual` shape (`model:""`) + `addCost` rejects
negative & non-finite with an addCost-facing message; cost components are stored
as-is with **no sum-to-total assertion**; central model resolution
(reported→configured→"unknown model"); kind-specific `totalTokens` fallback and a
**cached-image case that fails if input+cache are summed twice**; USD asserted
(non-USD → unpriced); each source records **exactly once** (no memory/image
double-charge, preserving branch-token/guard/no-frame ordering); meter
`(kind,model)` bucketing + attribution reconciliation (only when complete) +
safe-int guards; IPC round-trip preserves valid money and sets `usageComplete=false`
on an unusable-kind delta (never drops), incl. **grandchild relay**; snapshot
returns deep copies (top-level cost/tokens, an entry, nested entry fields) with
sibling `usageComplete` and deterministic entry order.

**statelog**: `recordHostedInvocation` writes parent + N details in one
transaction; duplicate `execution_attempt_id` is a no-op; a failed detail insert
rolls back; **a tolerated detail discrepancy does not change the billed project
total** (billed from parent); join-safe aggregation does not fan-out multiply;
per-model/per-kind breakdown correct; zero-spend and attempt-only invocations
counted; `usageComplete=false` on any invocation ⇒ lower-bound project total;
non-USD/negative rejected by constraints.

## Effort

agency: a focused rewrite of the invocationUsage value layer + the observation
API + four call sites + IPC + tests — it *removes* the #802
`unattributed`/`modelAttributionComplete`/version-skew special-casing.
statelog: a new migration + `recordHostedInvocation` + join-safe aggregation +
API/CLI — the larger half, but the schema is plain columns and query-friendly.
Deliver as two plans (agency producer/transport; statelog storage/query/API) with
a pinned rollout order.
