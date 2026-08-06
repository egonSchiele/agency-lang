# Full Cost & Token Breakdown — agency-lang Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete hosted-invocation cost and token breakdown, preserve recoverable accounting across subprocess IPC, and expose project and account spend through `agency remote spend`.

**Architecture:** Provider, attempt, and manual observations pass through one normalizer and one synchronous accounting sink. The meter keeps authoritative flat totals and best-effort `(kind, model)` attribution; IPC independently recovers untrusted fields before calling that same sink. A new shared spend schema supports project and account clients, a pure window parser, renderers, and a thin Commander command.

**Tech Stack:** TypeScript, smoltalk, Node IPC, AsyncLocalStorage, Commander, Zod, Vitest.

**Companion plan:** `/Users/adityabhargava/statelog/docs/superpowers/plans/2026-08-04-full-cost-token-breakdown-statelog.md`. Task 1's snapshot is statelog's recorder input. Task 6's `ProjectSpend` and `AccountSpendRow` exactly mirror statelog Task 4. Ship both repositories as a pinned pair.

**Spec:** `docs/superpowers/specs/2026-08-04-full-cost-token-breakdown-design.md` (current revision 4 content).

## Global Constraints

- Use `type`, plain objects, and arrays. Do not use interfaces, maps, sets, dynamic imports, unbraced `if` statements, or single-character production names.
- Keep `getModelCosts()`, `__tokenStats`, `updateTokenStats`, `getCost()`, `getTokens()`, and `RunNodeResult.tokens` unchanged.
- Keep `usageComplete` beside `usage`. Keep USD as the only currency. Use `totalCost` and `totalTokens` as authoritative values; never derive them from component sums.
- Keep the approved #809 boundary visible: count rejected provider promises as unresolved attempts. Do not count resolved `Result.failure` values because smoltalk cannot yet distinguish pre-dispatch from post-dispatch failures. Implementing that distinction remains deferred to agency-lang #809.
- Save every expensive verification command to its own output file. Do not edit `docs/site/**`, `CHANGELOG.md`, generated templates, or fixtures unless a task explicitly names them.

---

### Task 1: Value types, exact normalization, and the meter

**Files:**
- Rewrite: `lib/runtime/invocationUsage.ts`
- Test: `lib/runtime/invocationUsage.test.ts`

**Interfaces — Produces:**

```ts
import type { EmbedResult, ImageGenResult, PromptResult } from "smoltalk";

type SmoltalkCost = NonNullable<
  PromptResult["cost"] | EmbedResult["costEstimate"] | ImageGenResult["costEstimate"]
>;
type SmoltalkTokens = NonNullable<
  PromptResult["usage"] | EmbedResult["tokenUsage"] | ImageGenResult["tokenUsage"]
>;

export type ProviderUsageKind = "completion" | "embedding" | "image";
export type UsageKind = ProviderUsageKind | "manual";
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
  model: string;
  cost: CostBreakdown;
  tokens: TokenBreakdown;
};
export type InvocationUsage = {
  cost: CostBreakdown;
  tokens: TokenBreakdown;
  unknownCostCallCount: number;
  pricingComplete: boolean;
  entries: UsageEntry[];
};
export type InvocationUsageSnapshot = {
  usage: InvocationUsage;
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
export function normalizeObservation(observation: UsageObservation): NormalizedDelta;
export function normalizeIpcUsageDelta(raw: unknown): NormalizedDelta | null;
export function usageReconcileTolerance(total: number): number;
export class InvocationUsageMeter {
  merge(delta: NormalizedDelta): boolean; // true only when this merge newly makes usage incomplete
  markIncomplete(): boolean;
  snapshot(): InvocationUsageSnapshot;
}
```

Use `MAX_COUNT = Number.MAX_SAFE_INTEGER`. Apply this count policy everywhere:

| Boundary | Policy |
|---|---|
| Trusted provider token field | Accept a nonnegative safe integer. An absent component becomes `0` without degradation. A present malformed component becomes `0` and sets `attributionLost=true`; if a present `totalTokens` is malformed, use the kind-specific fallback from the normalized components and set `attributionLost=true`. The provider entry remains attributed, but the snapshot is a lower bound. |
| Trusted derived `totalTokens` | Add with a checked saturating helper. If the exact fallback exceeds `MAX_COUNT`, return `MAX_COUNT` and set `attributionLost=true`; the provider entry remains attributed and the sink degrades `usageComplete`. |
| Untrusted IPC token or unknown-count field | Accept only a nonnegative safe integer. An absent or malformed field becomes `0` and sets `attributionLost=true`; independently valid fields survive. |
| Invalid IPC cost bump | Add one to normalized `unknownCostCallCount`. Saturate at `MAX_COUNT`; saturation sets `attributionLost=true`. |
| Meter accumulation, every token field and unknown count | Checked-add each pair. If the exact sum exceeds `MAX_COUNT`, store `MAX_COUNT`, transition the meter to incomplete, and have `merge` return `true` only for that first transition. Never perform the unsafe addition first. The sink relays the incompleteness marker upward after the normalized delta, so every ancestor preserves the safe-integer lower-bound contract. |

Named provider cost components follow an independent rule: copy a component only when it is a finite nonnegative number; map absent, negative, `NaN`, and either infinity to `0`. Do not reconcile components to `totalCost`. A provider price is valid only when `totalCost` is finite and nonnegative and `currency === "USD"`. Otherwise all six cost fields become zero and `unknownCostCallCount` increases by one, even when named components look valid. A valid total keeps each independently normalized component. `totalCost: 0` is known-free.

Use a nested null-prototype index for bucketing: `Record<UsageKind, Record<string, number>>`, with both levels created through `Object.create(null)`. The outer key is `kind`; the inner key is the unmodified model. The stored number indexes the stable first-seen `entries` array. Do not use a concatenated composite key.

- [ ] **Step 1: Write failing normalizer tests.** Cover valid USD cost; each absent component; each component as negative, `NaN`, `Infinity`, and `-Infinity`; valid `totalCost` with malformed components; and invalid/non-USD `totalCost` with apparently valid components. Assert the authoritative valid total survives while malformed named components become zero, and invalid total makes the whole call unpriced.
- [ ] **Step 2: Add failing token-limit tests.** For every `TokenBreakdown` field and `unknownCostCallCount`, cover `MAX_COUNT`, `MAX_COUNT + 1` as an individual input, and accumulation of `MAX_COUNT + 1`. Assert every output remains a safe integer. Assert a present malformed trusted count and fallback saturation set `NormalizedDelta.attributionLost=true`; after merging and marking that delta, the snapshot has `usageComplete:false`. Assert accumulation saturation makes the snapshot incomplete and `merge` returns `true` only for the first overflow-driven complete→incomplete transition. Cover completion fallback saturation and embedding/image `input + output` saturation. Task 2 separately verifies upward marker relay from these transitions.
- [ ] **Step 3: Add the remaining failing value-layer tests.** Cover reported/configured/`"unknown model"` resolution; manual `model:""`; attempt with no entry; provider-total and kind-specific token fallback; cached-image overlap; separate `(kind, model)` buckets; first-seen order; conditional reconciliation only when `usageComplete`; and deep-copy snapshots including nested cost and token objects.
- [ ] **Step 4: Run the focused test and save failure output.** Run `pnpm test:run lib/runtime/invocationUsage.test.ts > .tmp-cost-t1-fail.log 2>&1`. Expected: FAIL on the new contracts.
- [ ] **Step 5: Implement the types, helpers, normalizer, and meter.** Remove `models`, `unattributed`, `modelAttributionComplete`, `UsageAttribution`, `completionUsageDelta`, and `paidCostDelta`. Keep helpers pure. Never add unsafe integers before checking `left > MAX_COUNT - right`.
- [ ] **Step 6: Run `pnpm test:run lib/runtime/invocationUsage.test.ts > .tmp-cost-t1-pass.log 2>&1`.** Expected: PASS.
- [ ] **Step 7: Commit with message** `feat(serve): add full cost and token usage values`.

---

### Task 2: One accounting sink, public observations, and guarded manual cost

**Files:**
- Modify: `lib/runtime/recordPaidUsage.ts`
- Modify: `lib/runtime/cost.ts`
- Test: `lib/runtime/recordPaidUsage.test.ts`

**Interfaces — Produces:**

```ts
function recordUsageDelta(
  target: { ctx: RuntimeContext<GraphState>; stack: StateStack },
  delta: NormalizedDelta,
): void;
export function recordUsage(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  observation: UsageObservation,
): void;
export function recordUnresolvedAttempt(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  kind: ProviderUsageKind,
): void;
export function recordNormalizedUsageDelta(
  ctx: RuntimeContext<GraphState>,
  stack: StateStack,
  delta: NormalizedDelta,
): void;
export function addCost(amount: number): void;
```

`recordUsageDelta` is private to `recordPaidUsage.ts`. It synchronously calls `billCharge(delta.cost.totalCost)`, merges once, and marks usage incomplete when `attributionLost`. It then attempts one parent relay of the normalized delta. If either `merge` reported its first overflow-driven transition or `markIncomplete()` returned true for attribution loss, it attempts one `invocationUsageIncomplete` relay **after** the delta; FIFO therefore preserves recovered money before degrading the ancestor. Never send the marker more than once for the same meter transition. `recordNormalizedUsageDelta` is the narrow IPC entry point into that sink. It must not normalize again and must not enforce guards.

- [ ] **Step 1: Write failing tests.** Assert sink order with spies: bill, merge/mark, delta relay attempt, then incompleteness-marker attempt. Distinguish a relay attempt from an emitted IPC message: outside IPC mode or for an all-zero delta, `process.send` emits nothing. Assert one sink invocation per observation. Assert malformed trusted-token and overflow transitions emit at most one upward incompleteness marker while preserving the normalized delta first. Test manual cost, unknown attempt, two models, and `addCost` rejection for negative and non-finite values with `addCost: amount must be a finite, non-negative number`.
- [ ] **Step 2: Run `pnpm test:run lib/runtime/recordPaidUsage.test.ts > .tmp-cost-t2-fail.log 2>&1`.** Expected: FAIL.
- [ ] **Step 3: Implement the sink and wrappers.** `addCost` validates first, calls `recordUsage(..., { type:"manual", amount })`, then calls `stack.enforceGuards()` exactly once.
- [ ] **Step 4: Run `pnpm test:run lib/runtime/recordPaidUsage.test.ts > .tmp-cost-t2-pass.log 2>&1`.** Expected: PASS.
- [ ] **Step 5: Commit with message** `feat(serve): centralize invocation usage accounting`.

---

### Task 3: Wire currently observable provider outcomes into all sources

**Files:**
- Modify: `lib/runtime/prompt.ts`
- Modify: `lib/runtime/memory/manager.ts`
- Modify: `lib/stdlib/image.ts`
- Test: `lib/runtime/prompt.test.ts`
- Test: `lib/runtime/memory/manager.test.ts`
- Test: `lib/stdlib/image.test.ts`

**Interfaces — Consumes:** `recordUsage`, `recordUnresolvedAttempt`, and the Task 1 observation union.

- [ ] **Step 1: Write the currently observable provider-outcome tests.** For completion, embedding, and image, cover priced, priced-zero, invalid/non-USD price, and rejected promise. A rejected promise records one attempt. A resolved `Result.failure` records nothing pending #809. Assert one sink invocation/relay attempt, not one emitted IPC message unless the test explicitly enables IPC and spies on `process.send`. Assert old scalar accounting is absent.
- [ ] **Step 2: Add ordering tests.** Prompt calls `recordUsage` first, then preserves the current `targetStack.localTokens += completion.usage?.totalTokens ?? 0` branch-local update exactly once, then continues to memory hooks; enforcement remains in its existing surrounding flow. Assert `getTokens()`/branch-local token totals are unchanged for provider totals, missing totals, and repeated completions. The memory helper no-ops when `agencyStore.getStore()` has no frame. With a frame, it obtains `ctx` and `stack`, records exactly once, then calls `stack.enforceGuards()`; best-effort catches must rethrow guard errors.
- [ ] **Step 3: Specify and test image success ordering.** For a successful provider result with an image: `recordUsage` first; `addTokens` exactly once; `imageGeneration` statelog event; `stack.enforceGuards()` last; then encode and return the image. For a successful provider result with no image: `recordUsage` first; `addTokens` exactly once; do not emit `imageGeneration` because its contract requires an image result; `stack.enforceGuards()` last; then return `failure("Image generation returned no images.")`. A guard trip wins over either return and propagates. Provider failure performs none of these success side effects.
- [ ] **Step 4: Run focused tests.** Run `pnpm test:run lib/runtime/prompt.test.ts lib/runtime/memory lib/stdlib/image.test.ts > .tmp-cost-t3-fail.log 2>&1`. Expected: FAIL before implementation.
- [ ] **Step 5: Implement source observations.** Prompt uses completion model/cost/usage, then performs the existing branch-local `localTokens` update after recording and before memory hooks; do not move that compatibility side effect into the general sink. Memory text uses completion fields; embedding uses `EmbedResult.model`, `costEstimate`, and `tokenUsage`. Replace `chargeCostIfInFrame` with a provider-observation wrapper that explicitly enforces the active stack after recording. Image uses the result model/configured model, cost estimate, and token usage. Remove replaced `addCost` calls.
- [ ] **Step 6: Run the same focused command to `.tmp-cost-t3-pass.log`.** Expected: PASS.
- [ ] **Step 7: Commit with message** `feat(serve): observe usage from every provider source`.

---

### Task 4: Recover and relay untrusted IPC usage

**Files:**
- Modify: `lib/runtime/costTelemetry.ts`
- Modify: `lib/runtime/ipc.ts`
- Test: `lib/runtime/costTelemetry.test.ts`
- Test: `lib/runtime/ipc.test.ts`

**Interfaces — Produces:**

```ts
export type IpcInvocationUsageMessage = {
  type: "invocationUsage";
  cost?: unknown;
  tokens?: unknown;
  unknownCostCallCount?: unknown;
  entry?: unknown;
  attributionLost?: unknown;
};

// Trusted send-side payload after removing `type`:
export type IpcInvocationUsagePayload = NormalizedDelta;
```

The message type describes untrusted receive data. `sendInvocationUsageToParent(delta: NormalizedDelta)` sends `{ type:"invocationUsage", ...delta }`. `normalizeIpcUsageDelta` applies this field-by-field table:

| Field | Recovery |
|---|---|
| Non-object message | Return `null`; nothing is recoverable. |
| `cost` | Normalize each named component independently to finite nonnegative or zero. A finite nonnegative USD `totalCost` is authoritative. Invalid/missing/non-USD total makes all cost fields zero and checked-bumps unknown count once. |
| `tokens` | Normalize each count independently under Task 1's IPC policy. Valid token fields survive malformed cost and malformed sibling token fields. |
| `unknownCostCallCount` | Valid nonnegative safe integer survives. Invalid/missing becomes zero and sets `attributionLost=true`; malformed cost then applies its checked bump. |
| `entry.kind` | Accept only the four `UsageKind` literals. Invalid/missing kind omits the entire entry and sets `attributionLost=true`. |
| `entry.model` | Require `""` exactly for manual and a nonempty string for provider kinds. Violation omits the entry and sets `attributionLost=true`. |
| `entry.cost` and `entry.tokens` | Never override flat totals. Normalize independently. Invalid entry cost becomes zero, invalid entry token fields become zero, and either sets `attributionLost=true`; the entry survives when kind/model are valid. |
| Top-level `attributionLost` | Only literal `true` is accepted as true. Any other value contributes false; local recovery findings still set true. |

Token-only attribution is mandatory: valid flat tokens plus valid entry kind/model preserve an entry with normalized tokens and zero cost. Invalid flat cost increments unknown count exactly once. Valid flat cost/tokens with invalid kind/model preserve flat totals, omit the entry, and set `attributionLost=true`. The sink relays this normalized recovered delta once, including its `attributionLost` value.

- [ ] **Step 1: Write send-side tests.** Assert the complete nested payload and all-zero suppression. Distinguish sink relay attempts from actual messages by enabling IPC and spying on `process.send` only in emission tests.
- [ ] **Step 2: Write receive normalization tests.** Cover every row of the table, every count at `MAX_COUNT`, malformed-cost bump at `MAX_COUNT`, malformed entry components that leave flat fields untouched, token-only entry survival, unusable kind/model, and a wholly non-object message.
- [ ] **Step 3: Add IPC-flow tests.** Cover child accounting, grandchild normalized relay, malformed-kind relay with `usageComplete=false`, two-session isolation, parent guard enforcement, and terminal FIFO ordering. Assert normalization, sink accounting, relay, and guard enforcement are synchronous with no `await` between them.
- [ ] **Step 4: Run `pnpm test:run lib/runtime/costTelemetry.test.ts lib/runtime/ipc.test.ts > .tmp-cost-t4-fail.log 2>&1`.** Expected: FAIL.
- [ ] **Step 5: Implement the transition inventory.** Update every message union and `handleChildMessage` branch. Replace the receive branch with `normalizeIpcUsageDelta(msg)` followed by `recordNormalizedUsageDelta(...)`, then enforce live-session guards. Remove legacy `{ costUsd }`, `IpcTelemetryMessage`, `isPayableCost`, and every `modelAttributionIncomplete` type, sender, handler, import, and test. Keep accounting before terminal settlement and introduce no await.
- [ ] **Step 6: Run the same tests to `.tmp-cost-t4-pass.log`.** Expected: PASS.
- [ ] **Step 7: Commit with message** `feat(serve): recover and relay full usage over IPC`.

---

### Task 5: Surface the snapshot on every serve outcome

**Files:**
- Verify only: `lib/serve/http/adapter.ts`
- Test: `lib/serve/http/adapter.test.ts`
- Test: `lib/serve/http/serveCostSeam.integration.test.ts`

**Interfaces — Consumes:** `InvocationUsageSnapshot`; the adapter copies `usage` and sibling `usageComplete` without recomputation.

- [ ] **Step 1: Add tests.** Cover success with manual cost, thrown outcomes, interrupt/resume, authoritative totals, manual entry, and `usageComplete` as a sibling rather than a child of `usage`.
- [ ] **Step 2: Run `pnpm test:run lib/serve/http/adapter.test.ts lib/serve/http/serveCostSeam.integration.test.ts > .tmp-cost-t5.log 2>&1`.** Expected: PASS without adapter logic changes. If a test exposes stale shape-only code, change only that shape copy.
- [ ] **Step 3: Commit tests with message** `test(serve): cover full usage on every route outcome`.

---

### Task 6: Build the spend wire, clients, window, rendering, and command

**Files** (all six spend files + the client `getSpend`/`getAccountSpend` methods already exist from #806 with the OLD flat `ProjectSpend`; this task **replaces** the shape, not greenfield):
- Rewrite: `lib/cli/statelog/spendTypes.ts` (replace the flat `ProjectSpend` with the full-breakdown shape)
- Rewrite: `lib/cli/statelog/spendTypes.test.ts`
- Modify: `lib/cli/statelog/projectClient.ts` (`getSpend` return type → new `ProjectSpend`; keep the one request path)
- Modify: `lib/cli/statelog/projectClient.test.ts`
- Modify: `lib/cli/statelog/accountClient.ts` (`getAccountSpend` return type → new `AccountSpendRow[]`)
- Modify: `lib/cli/statelog/accountClient.test.ts`
- Reuse/verify: `lib/cli/remote/commands/spendWindow.ts` (window logic unchanged from #806 — likely no edit; add `--by-model`/`--by-kind` only in `spend.ts`)
- Reuse/verify: `lib/cli/remote/commands/spendWindow.test.ts`
- Rewrite: `lib/cli/remote/commands/spend.ts` (render the new shape; wire `--by-model`/`--by-kind`)
- Rewrite: `lib/cli/remote/commands/spend.test.ts`
- Modify: `lib/cli/remote/render.ts` (replace `renderProjectSpend`/`renderAccountSpend` for the new shape)
- Modify: `lib/cli/remote/render.test.ts`
- Modify: `scripts/agency.ts` (add `--by-model`/`--by-kind`)
- Modify: `scripts/agency.test.ts`

**Interfaces — Produces:**

```ts
export type ModelKindSpend = {
  model: string;
  kind: UsageKind;
  cost: CostBreakdown;
  tokens: TokenBreakdown;
};
export type ProjectSpend = {
  cost: CostBreakdown;
  tokens: TokenBreakdown;
  invocationCount: number;
  unpricedCallCount: number;
  pricingComplete: boolean;
  usageComplete: boolean;
  breakdown: ModelKindSpend[];
};
export type AccountSpendRow = {
  projectSlug: string;
  deletedAt: string | null;
  spend: ProjectSpend;
};
export type SpendWindow = { from: number | null; to: number | null };
export type SpendWindowOptions = { since?: string; from?: string; to?: string };
export type ResolvedSpendWindow = SpendWindow & { description: string };
export type SpendOptions = AccountCommandOptions & SpendWindowOptions & {
  json?: boolean;
  byModel?: boolean;
  byKind?: boolean;
};
export function resolveSpendWindow(options: SpendWindowOptions, now?: number): ResolvedSpendWindow;
export function toSpendQuery(window: SpendWindow): Record<string, string>;
export function runSpend(
  project: string | undefined,
  options: SpendOptions,
  context: RemoteCommandContext,
): Promise<void>;
```

Own transport in the existing sealed clients. Add `ProjectClient.getSpend(window): Promise<ProjectSpend>` to `projectClient.ts` and `AccountClient.getAccountSpend(window): Promise<AccountSpendRow[]>` to `accountClient.ts`; do not create a third HTTP client. Both clients send `Authorization: Bearer <key>`, parse statelog's existing `{ success, value, error }` envelope, and validate the camelCase envelope value with strict Zod schemas. Statelog Task 4 emits these camelCase values; there is no spend-specific snake-case transformation.

Project mode uses `GET /api/projects/:encodedSlug/spend?from=<epoch-ms>&to=<epoch-ms>` and accepts a project- or account-scoped key. Account mode uses `GET /api/spend?...` and requires an account-scoped key. Preserve the existing known 403 as `AccountScopeError`, so `failAccount` prints the account-key hint. On either spend route, an unmatched 404 means `this statelog host does not support the spend API (upgrade the host)`; project `404 { error:"Project not found" }` retains the project-not-found error. Non-404 HTML/non-JSON responses retain normal HTTP errors. A successful incompatible shape throws the client-specific request error containing `incompatible statelog version`.

Use strict schemas for every object. Costs must be finite and nonnegative, currency must equal USD, all counts must be nonnegative safe integers, `pricingComplete` must equal `unpricedCallCount === 0`, kinds and model sentinel must match, `deletedAt` must be null or ISO datetime, and no extra fields are accepted. The project empty identity is all cost/token/count values zero, both completeness flags true, and `breakdown: []`. Account JSON is the raw `AccountSpendRow[]`, including deleted and zero-event projects; project JSON is the raw `ProjectSpend`.

Selection is positional-only: bare `agency remote spend` always selects account mode. `agency remote spend <project>` selects that slug. A linked directory may provide host/key defaults but never changes bare account mode into project mode. Project resolution calls `resolveProjectTarget(context, { ...options, project })`; account resolution calls `resolveAccountTarget(context, options)`.

Window contract: no flags means `{from:null,to:null,description:"all time"}`. `--since <duration>` uses `parseDurationMs`, requires a positive whole-millisecond safe integer, cannot combine with `--from` or `--to`, and produces `[now-duration, now)`. `--from` and `--to` accept nonnegative safe epoch milliseconds, `YYYY-MM-DD` at UTC midnight, or ISO datetime with explicit `Z`/offset. Reject invalid calendar dates, local datetimes, out-of-Date-range values, and `from >= to`. Omit null query keys; serialize present keys as decimal `from` and `to`.

Commander registration is exactly:

```ts
remoteCmd
  .command("spend")
  .description("Show hosted spend for a project or the whole account")
  .argument("[project]", "project slug; omit for the account-wide rollup")
  .option("--since <duration>", "window ending now, for example 24h, 7d, or 2w")
  .option("--from <when>", "window start as ISO-8601 with zone or epoch-ms")
  .option("--to <when>", "window end as ISO-8601 with zone or epoch-ms")
  .option("--json", "emit JSON for machine use")
  .option("--by-model", "group the breakdown by model")
  .option("--by-kind", "group the breakdown by operation kind")
  .option(HOST_OPTION, HOST_DESC)
  .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
  .action((project: string | undefined, options: SpendOptions) =>
    runSpend(project, options, getConfigContext()),
  );
```

Human output always shows authoritative cost component lines, token components and total, invocation count, USD, and trust markers. `--by-model` groups by model; `--by-kind` groups by kind; both group by the pair. Sort groups by `cost.totalCost` descending, then model and kind ascending. Label model `""` as `(manual)`. Render adaptive money (`$0.0000` only for zero; `<$0.0001` for positive values below that threshold). Prefix totals with `≥` when either completeness flag is false, and print separate telemetry-incomplete and unknown-price notes. A zero-spend project prints `No spend in <description>.`; account mode still prints one row for every returned project, marks deleted rows, and includes zero-event rows.

- [ ] **Step 1: Write schema and window tests.** Cover every field invariant, strict extras, complete empty identities, account row metadata, all accepted window forms, every rejection above, and exact query omission/serialization.
- [ ] **Step 2: Write client tests.** Cover exact encoded URLs, envelopes, project/account key behavior, account-scope hint translation, project-not-found versus unsupported-host 404, non-JSON 5xx, incompatible-version schema errors, deleted projects, and zero-event projects.
- [ ] **Step 3: Write renderer and command tests.** Cover component lines, both notes independently and together, adaptive money, each grouping mode and tie-break, manual label, project empty output, account deleted/zero rows, raw project JSON object, raw account JSON array, positional selection, linked-project non-selection, host/key forwarding, and invalid-window failure before any request.
- [ ] **Step 4: Write Commander tests.** Parse the full option set and assert exact `runSpend` arguments. Parse bare `remote spend` and assert `project === undefined`. Add `spend` to the sorted remote-subcommand assertion.
- [ ] **Step 5: Run focused tests to `.tmp-cost-t6-fail.log`.** Run `pnpm test:run lib/cli/statelog/spendTypes.test.ts lib/cli/statelog/projectClient.test.ts lib/cli/statelog/accountClient.test.ts lib/cli/remote/commands/spendWindow.test.ts lib/cli/remote/commands/spend.test.ts lib/cli/remote/render.test.ts scripts/agency.test.ts > .tmp-cost-t6-fail.log 2>&1`. Expected: FAIL.
- [ ] **Step 6: Implement the schemas, existing-client extensions, pure window parser, renderers, command, and registration.** Keep one request path in each client and infer wire types from Zod schemas.
- [ ] **Step 7: Run the same focused command to `.tmp-cost-t6-pass.log`.** Expected: PASS.
- [ ] **Step 8: Commit with message** `feat(remote): add full breakdown spend command`.

---

### Task 7: Verification

- [ ] Run `pnpm run typecheck > .tmp-cost-typecheck.log 2>&1`. Expected: exit 0 and no diagnostics.
- [ ] Run `pnpm run lint:structure > .tmp-cost-structure.log 2>&1`. Expected: exit 0.
- [ ] Run `make > .tmp-cost-make.log 2>&1`. Expected: exit 0; runtime and stdlib artifacts build successfully.
- [ ] Run `pnpm test:run > .tmp-cost-tests.log 2>&1`. Expected: exit 0 and zero failed tests. Do not run watch mode.
- [ ] Inspect each log independently. Do not overwrite one command's evidence with another command.
- [ ] Remove `.tmp-cost-t1-fail.log`, `.tmp-cost-t1-pass.log`, `.tmp-cost-t2-fail.log`, `.tmp-cost-t2-pass.log`, `.tmp-cost-t3-fail.log`, `.tmp-cost-t3-pass.log`, `.tmp-cost-t4-fail.log`, `.tmp-cost-t4-pass.log`, `.tmp-cost-t5.log`, `.tmp-cost-t6-fail.log`, `.tmp-cost-t6-pass.log`, `.tmp-cost-typecheck.log`, `.tmp-cost-structure.log`, `.tmp-cost-make.log`, and `.tmp-cost-tests.log` after recording the results in the handoff.
- [ ] Report the pinned statelog version requirement and the #809 limitation. Do not claim resolved `Result.failure` coverage.

## Self-review

- Cost components normalize independently; malformed named components cannot persist, and invalid/non-USD totals remain unpriced regardless of component appearance.
- Trusted input, IPC input, malformed-cost bumps, fallback arithmetic, and meter accumulation all have one exact safe-integer policy with boundary tests for every count; every lossy normalization or saturation degrades and relays `usageComplete` exactly once.
- IPC has a concrete untrusted wire shape and recovery table. Token-only attribution survives, authoritative flat values survive malformed attribution, and the normalized recovered delta relays once.
- Image success-with-image and success-without-image have explicit side effects and ordering. Memory explicitly records then enforces the active stack guard.
- The CLI extends the two existing sealed clients. Project/account schemas, camelCase wire values, auth, scope selection, windows, errors, JSON shapes, deleted/zero rows, and Commander registration are complete.
- Bucketing uses nested null-prototype objects without a composite delimiter. Verification commands use distinct output paths.
- The approved #809 defer remains out of scope and visible in tests, implementation instructions, and handoff documentation.
