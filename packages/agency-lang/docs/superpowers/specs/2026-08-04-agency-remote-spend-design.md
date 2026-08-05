# `agency remote spend` — Design

> Revised after review (`2026-08-04-agency-remote-spend-design-REVIEW.md`).
> Changes from v1: positional-only scope (no `--project`/binding scope fallback);
> `resolveSpendWindow` produces only server-valid bounds **plus** a presentation
> `description`, with strict positivity/safe-integer/range/timezone validation;
> renderers consume that `description`, never raw CLI options; the account TOTAL
> aggregates both trust axes (lower-bound + summed unpriced); adaptive money
> formatting never renders positive spend as `$0.0000`; wire schemas enforce
> numeric invariants and are the source of truth for the types; the
> unsupported-host error is specified with a concrete 404 policy.
>
> Changes from v2 (second review): use the real API names — `ProjectTarget.projectSlug`,
> the account client's `parseValue` (project client keeps `parseWire`), and add
> `"spend"` to the sealed `AccountRoute` union + the client interface types;
> narrow the unsupported-host classification to an **HTTP 404 only** (a proxy's
> non-JSON 5xx stays a server/reachability error); and make `resolveSpendWindow`
> genuinely pure — it returns-or-throws, and `runSpend` converts the throw
> (including `parseDurationMs`'s) through the command `fail()` boundary.

## Background: what this is and why now

Statelog can host an agent and, as of its Group 4 work (statelog PR #18), it records the cost of every hosted invocation into a `usage_events` ledger and exposes two read endpoints that aggregate it:

- `GET /api/projects/:slug/spend` — one project's total spend.
- `GET /api/spend` — the whole account's spend, per project.

These are the read surface the serve cost seam (agency-lang #801) and per-model breakdown (#802) were built to feed. On the agency-lang side there is **no CLI command that reads them** — a user who wants "how much has this agent cost?" must open the statelog web UI. Every neighbouring endpoint already has a CLI (`whoami`, `projects`, `keys`, `logs`, `pull`, `call`, `deploy`, `ls`, `open`, `link`). Spend is the gap.

This spec adds `agency remote spend` — a thin, read-only command in the `agency remote` family that prints a project's, or the whole account's, spend.

## What the server returns (verified against statelog #18)

Both endpoints return statelog's `Result` envelope wrapping a `ProjectSpend`:

```ts
type ProjectSpend = {
  pricedCost: number;        // dollars, the authoritative total
  inputTokens: number;
  outputTokens: number;
  invocationCount: number;   // hosted invocations in the window
  unpricedCallCount: number; // LLM calls with no price metadata
  pricingComplete: boolean;  // === (unpricedCallCount === 0)
  usageComplete: boolean;    // false ⇒ pricedCost is a trusted LOWER BOUND
};
```

- Per-project → one `ProjectSpend`.
- Account → `{ projectSlug: string, deletedAt: string | null, spend: ProjectSpend }[]`, **one row per project the account owns** (a project with no events returns a zero-filled `ProjectSpend`, not an absent row). `deletedAt` is set for a soft-deleted project whose billing ledger is preserved.

Both accept an optional half-open window `[from, to)` as query params **`from` / `to` in epoch milliseconds** — non-negative integers within `Date`'s representable range; either bound omittable; out-of-range rejected server-side.

The two trust axes are the serve cost seam's: `pricingComplete` (were all calls priced?) and `usageComplete` (was all telemetry delivered — if false, the dollar figure is a lower bound). The CLI must surface both honestly rather than print a bare number that looks exact.

## Decisions baked in

1. **Positional-only scope. No `--project`, no binding scope-fallback.** `agency remote spend` (no argument) = the **account rollup**; `agency remote spend <project-slug>` = **one project**. Mode is chosen solely by whether the positional argument is present. `SpendOptions extends AccountCommandOptions` (NOT `ProjectCommandOptions`) — there is no `--project` flag and the linked-directory binding must **not** silently turn bare `spend` into "the linked project." The binding may still supply the **host** (origin); it never selects project scope. In the project branch the positional slug is passed explicitly: `resolveProjectTarget(context, { ...options, project })`.

2. **Human-friendly time flags; epoch-ms is internal.** `--since <duration>` (`24h`, `7d`, `2w`) sets `to = now`, `from = now − duration`. `--from <when>` / `--to <when>` take an ISO-8601 date/datetime **or** raw epoch-ms. No flag → all time. `--since` is mutually exclusive with `--from`/`--to`. All inputs are validated to produce only server-valid bounds (see `resolveSpendWindow`).

3. **`resolveSpendWindow` emits validated bounds *and* one presentation label.** To end the earlier signature confusion, window resolution returns a single declarative value:
   ```ts
   type ResolvedSpendWindow = { from: number | null; to: number | null; description: string };
   ```
   Clients consume `{ from, to }`; renderers consume `description` (e.g. `last 7d`, `since 2026-07-01T00:00:00Z`, `all time`). Renderers never inspect raw Commander options or re-derive time semantics, and `now` is captured exactly once.

4. **Both trust axes are always surfaced — including on the account TOTAL.** A project figure with `usageComplete=false` prints as a lower bound (`≥ $x`, plus a one-line note); `unpricedCallCount>0` is shown. The account TOTAL is itself degraded whenever *any* row is: `usageComplete(total) = rows.every(r => r.spend.usageComplete)`, `unpricedCallCount(total) = Σ`, and the total prints `≥` + a note when degraded.

5. **Flat totals only; per-model is out of scope** (the server aggregate has no per-model field yet — see "Out of scope"). The renderer is shaped so a future `models` field slots in.

6. **`--json` for machines, human table by default** (same dual-output convention as `remote logs`).

## Architecture

A thin command over the existing two-client split — mirrors `whoami`/`projects` (account-scoped) and `pull`/`logs` (project-scoped).

```
agency remote spend [project]
        │  resolveSpendWindow(opts) → { from, to, description }   (once)
        │
        ├─ no project ─► resolveAccountTarget ─► accountClient.getAccountSpend({from,to}) ─► GET /api/spend
        │                    (account-scoped key)                                             ─► renderAccountSpend(rows, description) / printJson
        │
        └─ <project>  ─► resolveProjectTarget ─► projectClient.getSpend({from,to})          ─► GET /api/projects/:projectSlug/spend
                             (project or account key)                                          ─► renderProjectSpend(projectSlug, spend, description) / printJson
```

**Auth nuance (already handled by the shared helpers):** the account rollup needs an **account-scoped** key; `failAccount` already prints the "this is a project-scoped key; you need an account-scoped one" hint. The per-project endpoint works with a project or account key (`projectReadAccess`).

## File-by-file changes

### 1. `lib/cli/statelog/spendTypes.ts` (new) — the source of truth

Zod schemas with numeric invariants; the TS types are **inferred** from them so a hand-written type and its validator cannot drift.

```ts
import { z } from "zod";

const nonNegInt = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");

export const projectSpendSchema = z.object({
  pricedCost: z.number().finite().nonnegative(),
  inputTokens: nonNegInt,
  outputTokens: nonNegInt,
  invocationCount: nonNegInt,
  unpricedCallCount: nonNegInt,
  pricingComplete: z.boolean(),
  usageComplete: z.boolean(),
}).refine(
  (s) => s.pricingComplete === (s.unpricedCallCount === 0),
  "pricingComplete must equal (unpricedCallCount === 0)",   // both fields drive warnings; a contradictory pair is a server bug we reject
);
export type ProjectSpend = z.infer<typeof projectSpendSchema>;

export const accountSpendRowSchema = z.object({
  projectSlug: z.string().min(1),
  deletedAt: z.string().datetime().nullable(),
  spend: projectSpendSchema,
});
export type AccountSpendRow = z.infer<typeof accountSpendRowSchema>;

export type SpendWindow = { from: number | null; to: number | null };

/** Shared so both clients serialize the window identically (null bounds omitted,
 *  decimal ms). */
export function toSpendQuery(w: SpendWindow): Record<string, string> {
  const q: Record<string, string> = {};
  if (w.from !== null) q.from = String(w.from);
  if (w.to !== null) q.to = String(w.to);
  return q;
}
```

### 2. `lib/cli/remote/commands/spendWindow.ts` (new) — parse the time flags

Genuinely pure and unit-testable: it **returns** a `ResolvedSpendWindow` or **throws** an `Error` on invalid input. It never calls `fail()` or exits — so its tests assert on thrown messages with no process-exit mocking. `runSpend` catches and routes the message through the command `fail()` boundary. `parseDurationMs` also throws (a bad duration string); that throw is caught the same way, so it becomes a clean CLI error rather than a stack trace.

```ts
export type SpendWindowOptions = { since?: string; from?: string; to?: string };
export function resolveSpendWindow(options: SpendWindowOptions, now = Date.now()): ResolvedSpendWindow; // returns or throws Error
```

Rules (each violation → `throw new Error(...)` with a clear message):
- **Mutual exclusion:** `--since` with `--from` or `--to` → throw.
- **`--since d`:** `ms = parseDurationMs(d, "--since")` (may itself throw on a malformed string), then require `Number.isSafeInteger(ms) && ms > 0` (rejects `parseDurationMs`'s permitted negative / zero / fractional durations — e.g. `-1h`, `0h`, `0.1ms`; a duration like `0.5s` → integer `500` is fine). Compute `from = now - ms`; require `from` a non-negative safe integer in `Date` range (rejects a duration larger than `now`, i.e. a pre-epoch window). `to = now`. description = `last <d>`.
- **`--from` / `--to`:** each via `parseInstant(value, label)`:
  - all-digits → epoch-ms: require a non-negative safe integer within `Date` range.
  - `YYYY-MM-DD` → UTC midnight (`Date.parse(value + "T00:00:00Z")`).
  - datetime → require an explicit `Z` or numeric offset (reject a bare local datetime, so the result never depends on the machine timezone); parse and require a valid, in-range instant.
  - anything else → throw (do NOT fall through to a permissive `Date.parse`).
  - If both present, require `from < to`. description = `from <iso>`, `until <iso>`, or `from <iso> to <iso>`; a one-sided window keeps its single bound.
- **No flag:** `{ from: null, to: null, description: "all time" }`.

### 3. `lib/cli/statelog/projectClient.ts` — `getSpend` + query support + spend-unsupported 404

`request(...segments)` builds a path only; add query support (a `requestWithQuery(segments, query)` that appends a `URLSearchParams` when non-empty). Add `getSpend` to the exported `ProjectClient` type and implement it with the existing `parseWire` validator:

```ts
async getSpend(window: SpendWindow): Promise<ProjectSpend> {
  return parseWire(projectSpendSchema, await requestWithQuery(["spend"], toSpendQuery(window)));
}
```

**404 policy (fixes the misreport), narrowed to HTTP 404.** The current 404 branch throws "project not found" unconditionally. Change *only the 404 branch*: a **404** whose JSON body is exactly `{ error: "Project not found" }` keeps the "project '<slug>' not found — check the slug, or that it's deployed" message; **any other 404** from the `spend` route means the host predates the spend API → throw "this statelog host does not support the spend API (upgrade the host)". Non-404 failures keep the client's existing handling untouched — a proxy's HTML `502`/`503` stays a reachability/server error and is **not** relabelled as an old host. (Verified: statelog returns `404 {error:"Project not found"}` for a missing project via `projectAccess`, and has no JSON catch-all for an unmatched route, so the two 404s are distinguishable.)

### 4. `lib/cli/statelog/accountClient.ts` — `getAccountSpend` + query support

Add `"spend"` to the sealed `AccountRoute` union (`"whoami" | "projects" | "api_keys" | "spend"`) and add `getAccountSpend` to the exported `AccountClient` type. `request("GET"|"POST", route, body?)` gains query support (append the search string to `route`). Use the account client's existing validator, **`parseValue`** (not `parseWire`, which is the project client's):

```ts
async getAccountSpend(window: SpendWindow): Promise<AccountSpendRow[]> {
  return parseValue(z.array(accountSpendRowSchema), await request("GET", withQuery("spend", toSpendQuery(window))));
}
```

The account route has no project-not-found case, so a spend-route **404** → "host does not support the spend API"; non-404 failures keep the client's existing status/server-error/non-JSON handling.

### 5. `lib/cli/remote/render.ts` — `renderProjectSpend`, `renderAccountSpend`, money helper

Match the existing `color` style. Money via an **adaptive** helper that never renders positive spend as zero:

```ts
function formatUsd(n: number): string {           // n >= 0
  if (n === 0) return "$0.0000";
  if (n < 0.0001) return "<$0.0001";
  return `$${n.toFixed(4)}`;
}
function lowerBound(n: number, complete: boolean): string {
  return complete ? formatUsd(n) : `≥ ${formatUsd(n)}`;
}
```

- `renderProjectSpend(slug, spend, description)`:
  ```
  Spend: my-agent  (last 7d)
    Cost:         ≥ $0.4212   (lower bound — some telemetry incomplete)
    Tokens:       ↑ 12,400  ↓ 3,010
    Invocations:  87
    Unpriced:     2 calls (cost may be understated)
  ```
  The `≥`/lower-bound note appears only when `usageComplete=false`; the `Unpriced` line only when `unpricedCallCount>0`. Counts via a `formatCount` (thousands separators).

- `renderAccountSpend(rows, description)`:
  - Empty array → `No projects yet.` (an account WITH projects but no spend still returns zero-filled rows, so an empty array means no projects — not "no spend").
  - Otherwise a table with an `UNPRICED` column, one row per project; **total order:** active rows by `pricedCost` desc, then deleted rows (`(deleted)`) by `pricedCost` desc, `projectSlug` ascending as the tie-break.
  - A `TOTAL` line: cost = `lowerBound(Σ pricedCost, rows.every(r => r.spend.usageComplete))`; summed tokens / invocations / unpriced; a one-line note per degraded axis (any incomplete usage → lower-bound note; total unpriced > 0 → understated-cost note).

### 6. `lib/cli/remote/commands/spend.ts` (new)

```ts
export type SpendOptions = AccountCommandOptions & SpendWindowOptions & { json?: boolean };

export async function runSpend(project: string | undefined, options: SpendOptions, context: RemoteCommandContext): Promise<void> {
  let window: ResolvedSpendWindow;
  try {
    window = resolveSpendWindow(options);              // captures `now` once; throws on invalid flags / bad duration
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));   // the single window-error → CLI boundary
  }
  if (project === undefined) {
    const target = resolveAccountTarget(context, options);
    try {
      const rows = await createAccountClient(target.origin, target.apiKey).getAccountSpend(window);
      options.json ? printJson(rows) : console.log(renderAccountSpend(rows, window.description));
    } catch (error) { failAccount(error, target.apiKeyEnvName); }
    return;
  }
  const target = resolveProjectTarget(context, { ...options, project });   // ProjectTarget.projectSlug
  try {
    const spend = await createProjectClient(target.origin, target.projectSlug, target.apiKey).getSpend(window);
    options.json ? printJson(spend) : console.log(renderProjectSpend(target.projectSlug, spend, window.description));
  } catch (error) { failProjectCommand(error); }
}
```

### 7. `scripts/agency.ts` — register the subcommand

```ts
remoteCmd
  .command("spend")
  .description("Show hosted spend for a project (or the whole account)")
  .argument("[project]", "project slug (omit for the account-wide rollup)")
  .option("--since <duration>", "window ending now, e.g. 24h, 7d, 2w")
  .option("--from <when>", "window start — ISO-8601 (UTC/offset) or epoch-ms")
  .option("--to <when>", "window end — ISO-8601 (UTC/offset) or epoch-ms")
  .option("--json", "emit JSON for machine use")
  .option(HOST_OPTION, HOST_DESC)
  .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
  .action((project: string | undefined, opts: SpendOptions) => runSpend(project, opts, getConfigContext()));
```

## Testing (deterministic, no network — mock the client)

**`spendWindow.test.ts`** (asserts on thrown `Error` messages — no process-exit mocking, since the parser never calls `fail()`): `--since 7d` → `[now-Δ, now]` + `last 7d`; `--since` + `--from` → throws; `--since -1h` / `0h` / `0.1ms` → throws; `--since` larger than `now` (pre-epoch) → throws; a malformed `--since` string (the `parseDurationMs` throw) → throws; `--since 0.5s` → ms `500` accepted; `--from` epoch-ms and `--from 2026-07-01` (UTC midnight) both parse; bare local datetime (no `Z`/offset) → throws; non-ISO junk → throws; out-of-`Date`-range epoch → throws; `from >= to` → throws; **from-only** and **to-only** windows resolve (single bound, other `null`); no flags → `{null,null,"all time"}`.

**`spend.test.ts`:** no project → `getAccountSpend(window)` then render/`--json`; `<project>` → `getSpend(window)`; **an invalid time flag → `runSpend` converts the thrown window error to `fail()` and makes no client call**; account path surfaces the project-scoped-key hint via `failAccount`; `--json` prints exactly the value via `printJson` and nothing else; the resolved window is passed to the client unchanged.

**`render.test.ts`:** `renderProjectSpend` shows the `≥`/lower-bound note only when `usageComplete=false`, the `Unpriced` line only when `unpricedCallCount>0`; **zero cost → `$0.0000`, tiny positive (`0.00004`) → `<$0.0001`** (separate cases); `renderAccountSpend` total-order sort with an equal-cost tie-break, deleted-last, correct TOTAL; **a single incomplete/unpriced row makes the TOTAL visibly degraded** (lower-bound + summed unpriced); empty array → `No projects yet.`

**Client tests (`projectClient`/`accountClient`):** `getSpend`/`getAccountSpend` build the URL with `from`/`to` present, and **omit** each when null (from-only / to-only / neither); reject a malformed wire shape — negative cost, unsafe/negative counts, invalid `deletedAt`, and a contradictory `pricingComplete`/`unpricedCallCount` pair; **404 policy:** known `{error:"Project not found"}` JSON → project-not-found message; any other `404` on `spend` → "host does not support the spend API"; **regression:** a non-JSON `5xx` (e.g. a proxy's `503` HTML) stays a reachability/server error and is **not** relabelled unsupported-host.

## Out of scope — and the follow-up it sets up

**Per-model breakdown.** The server's `ProjectSpend` is flat — Group 4 was built against the #801 seam before the #802 per-model breakdown landed, so the runtime already *sends* `models`/`unattributed`/`modelAttributionComplete` but statelog does not yet record or aggregate them. `agency remote spend` shows flat totals now. The next step is a **statelog follow-up**: extend the `usage_events` ledger + `sumProjectSpend`/`sumAccountSpend` + `ProjectSpend` to carry per-model, after which this command grows a `--by-model` view (and a third trust marker for `modelAttributionComplete`) — the renderer is shaped to accept it. That follow-up is the real consumer of #802; this command is the client that motivates it.

Also out of scope: any write/settings op (read-only), CSV export (statelog dropped it; `--json` is the machine surface), and enforced spend caps (the budget-guard feature).

## Consumer/coupling notes

- Purely additive: one shared types module, two client methods, one window parser, two renderers, one command, one registration. No existing command changes.
- Requires a statelog serving the spend endpoints (Group 4 / #18). Against an older host the spend routes return a non-spend 404, which the client now reports as "host does not support the spend API" rather than a misleading "project not found."
