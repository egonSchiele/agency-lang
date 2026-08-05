# `agency remote spend` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agency remote spend [project]` — a read-only CLI command that prints one project's, or the whole account's, hosted spend from statelog's Group 4 endpoints.

**Architecture:** A thin command over the existing two-client split. A pure `resolveSpendWindow` turns the time flags into validated epoch-ms bounds plus a display label; the project/account clients gain a `getSpend`/`getAccountSpend` method (shared zod types + query serializer); renderers format the result; the command only selects scope and orchestrates.

**Tech Stack:** TypeScript CLI (`lib/cli/remote`, `lib/cli/statelog`), commander, zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-agency-remote-spend-design.md` (v3, post-two-reviews).

## Global Constraints

- NEVER use dynamic imports. Use objects not maps, arrays not sets, `type` not `interface`.
- Do NOT edit `docs/site/**` (user-facing docs are out of scope for a feature PR). Do NOT edit `CHANGELOG.md`. Do NOT commit to `main`; work on the task branch. Owner squash-merges the PR — do not merge it yourself.
- Lint (enforced): 1250 lines/file, 150 lines/function (style target 1000/100 per `docs/dev/coding-standards.md` — keep new files small and focused).
- Follow `docs/dev/anti-patterns.md`: keep transport mechanics private, use one request path per client, use descriptive variable names, and put braces around every `if` body.
- Commit messages / PR bodies go in a FILE passed with `git commit -F <file>`. Follow the repo's commit conventions (this environment appends the `Co-Authored-By: Claude Opus 4.8` trailer).
- **Before any push and at finish: run BOTH `pnpm run typecheck` AND the full `pnpm test:run`.** (Lesson from the last PR: `make` skips test-file typechecking, and scoped per-file test runs miss untouched files. `typecheck` = `tsc --noEmit && tsc -p tsconfig.tests.json && tsc -p tsconfig.evals.json`.) During a task, also run the task's own test file with `pnpm test:run <path>`.
- No codegen / no `make fixtures` / no `make` needed — this is CLI TypeScript only.
- Reuse existing fixtures/conventions, do not invent: remote command tests use a hoisted `vi.mock` of the client module + a `context()` returning `{ config, configPath }`, spy `console.log`/`console.error`, and mock `process.exit` to throw; `--json` writes via `printJson` → **`process.stdout.write`** (spy that, not `console.log`). See `lib/cli/remote/commands/projects.test.ts`.

---

### Task 1: Shared spend types + query serializer

The single source of truth: zod schemas with numeric invariants, TS types inferred from them, the `SpendWindow` bounds type, and the null-omitting query serializer both clients share.

**Files:**
- Create: `lib/cli/statelog/spendTypes.ts`
- Test: `lib/cli/statelog/spendTypes.test.ts`

**Interfaces — Produces:** `ProjectSpend`, `AccountSpendRow` (both `z.infer`'d), `projectSpendSchema`, `accountSpendRowSchema`, `SpendWindow`, `toSpendQuery`.

- [ ] **Step 1: Write the failing test** (`spendTypes.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { projectSpendSchema, accountSpendRowSchema, toSpendQuery } from "./spendTypes.js";

const valid = { pricedCost: 0.5, inputTokens: 10, outputTokens: 2, invocationCount: 3, unpricedCallCount: 0, pricingComplete: true, usageComplete: true };

describe("projectSpendSchema", () => {
  it("accepts a valid spend", () => { expect(projectSpendSchema.parse(valid)).toEqual(valid); });
  it("rejects non-finite/negative cost, unsafe/negative counts, contradictory completeness", () => {
    expect(() => projectSpendSchema.parse({ ...valid, pricedCost: -1 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, pricedCost: Number.NaN })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, pricedCost: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, inputTokens: -1 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, outputTokens: 2 ** 53 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, invocationCount: 2 ** 53 })).toThrow();
    expect(() => projectSpendSchema.parse({ ...valid, unpricedCallCount: 1, pricingComplete: true })).toThrow();
  });
});

describe("accountSpendRowSchema", () => {
  it("accepts null and ISO deletedAt, rejects junk", () => {
    expect(accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: null, spend: valid }).deletedAt).toBeNull();
    expect(accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: "2026-08-01T00:00:00.000Z", spend: valid }).deletedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(() => accountSpendRowSchema.parse({ projectSlug: "p", deletedAt: "nope", spend: valid })).toThrow();
  });
});

describe("toSpendQuery", () => {
  it("omits null bounds, serializes present ones as decimals", () => {
    expect(toSpendQuery({ from: null, to: null })).toEqual({});
    expect(toSpendQuery({ from: 1000, to: null })).toEqual({ from: "1000" });
    expect(toSpendQuery({ from: 1000, to: 2000 })).toEqual({ from: "1000", to: "2000" });
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm test:run lib/cli/statelog/spendTypes.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `lib/cli/statelog/spendTypes.ts` per the spec's File 1 section: schemas with `nonNegInt` refined by `Number.isSafeInteger`, `pricedCost` finite+nonnegative, the `pricingComplete === (unpricedCallCount === 0)` refinement, `deletedAt` as `z.string().datetime().nullable()`, inferred types, `SpendWindow`, and `toSpendQuery`. Use descriptive production names in the callbacks and serializer:

```ts
}).refine(
  (spend) => spend.pricingComplete === (spend.unpricedCallCount === 0),
  "pricingComplete must equal (unpricedCallCount === 0)",
);

export function toSpendQuery(window: SpendWindow): Record<string, string> {
  const query: Record<string, string> = {};
  if (window.from !== null) {
    query.from = String(window.from);
  }
  if (window.to !== null) {
    query.to = String(window.to);
  }
  return query;
}
```

- [ ] **Step 4: Run to verify pass** — same command → PASS.

- [ ] **Step 5: Commit** — `feat(remote): shared spend wire types + query serializer`

---

### Task 2: `resolveSpendWindow` — pure time-flag parsing

**Files:**
- Create: `lib/cli/remote/commands/spendWindow.ts`
- Test: `lib/cli/remote/commands/spendWindow.test.ts`

**Interfaces:**
- Consumes: `parseDurationMs` (`lib/duration.ts`), `SpendWindow` (Task 1).
- Produces: `SpendWindowOptions`, `ResolvedSpendWindow = SpendWindow & { description: string }`, `resolveSpendWindow(options, now?)` — **returns or throws `Error`; never calls `fail()`/exits.**

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveSpendWindow } from "./spendWindow.js";

const NOW = 1_800_000_000_000; // fixed for determinism

describe("resolveSpendWindow", () => {
  it("--since sets [now-Δ, now] and a label", () => {
    const resolved = resolveSpendWindow({ since: "7d" }, NOW);
    expect(resolved.to).toBe(NOW);
    expect(resolved.from).toBe(NOW - 7 * 24 * 3600 * 1000);
    expect(resolved.description).toBe("last 7d");
  });
  it("throws when --since combines with --from/--to", () => {
    expect(() => resolveSpendWindow({ since: "1d", from: "1000" }, NOW)).toThrow(/cannot be combined/);
  });
  it.each(["-1h", "0h", "0.1ms"])("throws on a non-positive/fractional --since %s", (duration) => {
    expect(() => resolveSpendWindow({ since: duration }, NOW)).toThrow();
  });
  it("throws when --since reaches before the epoch", () => {
    expect(() => resolveSpendWindow({ since: "9999d" }, 1000)).toThrow();
  });
  it("throws on a malformed --since string (parseDurationMs)", () => {
    expect(() => resolveSpendWindow({ since: "banana" }, NOW)).toThrow();
  });
  it("accepts --since 0.5s as 500ms", () => {
    expect(resolveSpendWindow({ since: "0.5s" }, NOW).from).toBe(NOW - 500);
  });
  it("trims --since before parsing and displaying it", () => {
    expect(resolveSpendWindow({ since: " 7d " }, NOW).description).toBe("last 7d");
  });
  it("rejects an invalid injected current time before using it", () => {
    expect(() => resolveSpendWindow({ since: "1s" }, 1000.5)).toThrow(/current time/);
  });
  it("parses --from epoch-ms and YYYY-MM-DD (UTC midnight)", () => {
    expect(resolveSpendWindow({ from: "1000" }, NOW).from).toBe(1000);
    expect(resolveSpendWindow({ from: "2026-07-01" }, NOW).from).toBe(Date.parse("2026-07-01T00:00:00Z"));
  });
  it("requires a Z/offset on a datetime, rejects bare local + junk + out-of-range", () => {
    expect(() => resolveSpendWindow({ from: "2026-07-01T12:00:00" }, NOW)).toThrow();
    expect(() => resolveSpendWindow({ from: "not-a-date" }, NOW)).toThrow();
    expect(() => resolveSpendWindow({ from: "99999999999999999" }, NOW)).toThrow();
    expect(resolveSpendWindow({ from: "2026-07-01T12:00:00Z" }, NOW).from).toBe(Date.parse("2026-07-01T12:00:00Z"));
  });
  it("rejects nonexistent calendar dates instead of normalizing them", () => {
    expect(() => resolveSpendWindow({ from: "2026-02-30" }, NOW)).toThrow(/valid date/);
    expect(() => resolveSpendWindow({ from: "2026-13-01" }, NOW)).toThrow(/valid date/);
    expect(() => resolveSpendWindow({ from: "2026-02-30T12:00:00Z" }, NOW)).toThrow(/valid date/);
  });
  it("rejects from >= to", () => {
    expect(() => resolveSpendWindow({ from: "2000", to: "1000" }, NOW)).toThrow(/before/);
  });
  it("resolves one-sided windows", () => {
    expect(resolveSpendWindow({ from: "1000" }, NOW)).toMatchObject({ from: 1000, to: null });
    expect(resolveSpendWindow({ to: "2000" }, NOW)).toMatchObject({ from: null, to: 2000 });
  });
  it("no flags → all time", () => {
    expect(resolveSpendWindow({}, NOW)).toEqual({ from: null, to: null, description: "all time" });
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

```ts
import { parseDurationMs } from "@/duration.js";
import type { SpendWindow } from "@/cli/statelog/spendTypes.js";

export type SpendWindowOptions = { since?: string; from?: string; to?: string };
export type ResolvedSpendWindow = SpendWindow & { description: string };

const MAX_DATE_TIMESTAMP_MS = 8.64e15;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireInstant(milliseconds: number, label: string): number {
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || milliseconds > MAX_DATE_TIMESTAMP_MS
  ) {
    throw new Error(`${label} is out of range`);
  }
  return milliseconds;
}

function requireCalendarDate(value: string, label: string): void {
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    Number.isNaN(milliseconds)
    || new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} is not a valid date`);
  }
}

function parseInstant(value: string, label: string): number {
  if (/^\d+$/.test(value)) {
    return requireInstant(Number(value), label);
  }
  if (DATE_ONLY.test(value)) {
    requireCalendarDate(value, label);
    return requireInstant(Date.parse(`${value}T00:00:00Z`), label);
  }
  if (DATETIME_WITH_ZONE.test(value)) {
    requireCalendarDate(value.slice(0, 10), label);
    const milliseconds = Date.parse(value);
    if (Number.isNaN(milliseconds)) {
      throw new Error(`${label} is not a valid datetime`);
    }
    return requireInstant(milliseconds, label);
  }
  throw new Error(
    `${label} must be epoch-ms, YYYY-MM-DD, or YYYY-MM-DDTHH:mm[:ss[.sss]] with Z/±HH:mm (got "${value}")`,
  );
}

function describe(from: number | null, to: number | null): string {
  if (from !== null && to !== null) {
    return `from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`;
  }
  if (from !== null) {
    return `from ${new Date(from).toISOString()}`;
  }
  if (to !== null) {
    return `until ${new Date(to).toISOString()}`;
  }
  return "all time";
}

export function resolveSpendWindow(options: SpendWindowOptions, now: number = Date.now()): ResolvedSpendWindow {
  const { since, from, to } = options;
  if (since !== undefined && (from !== undefined || to !== undefined)) {
    throw new Error("--since cannot be combined with --from/--to");
  }
  if (since !== undefined) {
    const normalizedSince = since.trim();
    const durationMs = parseDurationMs(normalizedSince, "--since");
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new Error("--since must be a positive whole-millisecond duration");
    }
    const currentTime = requireInstant(now, "current time");
    return {
      from: requireInstant(currentTime - durationMs, "--since window start"),
      to: currentTime,
      description: `last ${normalizedSince}`,
    };
  }
  const fromMs = from !== undefined ? parseInstant(from, "--from") : null;
  const toMs = to !== undefined ? parseInstant(to, "--to") : null;
  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    throw new Error("--from must be before --to");
  }
  return { from: fromMs, to: toMs, description: describe(fromMs, toMs) };
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat(remote): pure spend time-window resolver`

---

### Task 3: `projectClient.getSpend` + query support + spend-unsupported 404

**Files:**
- Modify: `lib/cli/statelog/projectClient.ts`
- Test: `lib/cli/statelog/projectClient.test.ts` (extend; if absent, create following the account client test style)

**Interfaces — Produces:** `ProjectClient.getSpend(window: SpendWindow): Promise<ProjectSpend>`. Route compatibility detection remains private to `projectClient.ts`.

- [ ] **Step 1: Write the failing tests** (mock `fetch`; mirror existing client tests)

Cover: `getSpend` GETs `/api/projects/:slug/spend?from=&to=` with bounds present, and **omits** each when null (from-only / to-only / neither); validates and **rejects** a malformed wire shape through `ProjectRequestError`; a `404 {error:"Project not found"}` → error message contains "not found"; both JSON and non-JSON unknown 404s on `spend` → message "does not support the spend API"; **a non-JSON 5xx stays a server error** (message contains "HTTP 503", not "spend API"). Retain the existing `pullSource` project-not-found regression test.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**
- Replace the rest-parameter request signature with one private, declarative transport input; update existing methods to use it. Do **not** add a second fetch/parse/error path:
  ```ts
  type ProjectRequest = {
    segments: string[];
    query?: Record<string, string>;
    unsupportedRouteMessage?: string;
  };

  async function request(input: ProjectRequest): Promise<unknown>;
  ```
- Have `projectRouteUrl` append `new URLSearchParams(input.query)` when non-empty, while `request` remains the only owner of fetch, auth, JSON/envelope parsing, and errors.
- In `request`'s 404 branch, preserve the exact `{ error: "Project not found" }` message first. If `input.unsupportedRouteMessage` is present, throw `ProjectRequestError(input.unsupportedRouteMessage)` for any other 404. With no compatibility message, preserve the existing project-not-found behavior for existing methods. No route-not-found class is exported or needed.
- `getSpend`:
  ```ts
  async getSpend(window) {
    const value = await request({
      segments: ["spend"],
      query: toSpendQuery(window),
      unsupportedRouteMessage: "this statelog host does not support the spend API (upgrade the host)",
    });
    return parseWire(projectSpendSchema, value);
  }
  ```
- Add `getSpend` to the exported `ProjectClient` type.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat(remote): projectClient.getSpend with spend-unsupported host detection`

---

### Task 4: `accountClient.getAccountSpend` + query support + `"spend"` route

**Files:**
- Modify: `lib/cli/statelog/accountClient.ts`
- Test: `lib/cli/statelog/accountClient.test.ts` (extend)

**Interfaces — Produces:** `AccountClient.getAccountSpend(window): Promise<AccountSpendRow[]>`; `AccountRoute` gains `"spend"`. Route compatibility detection remains private to `accountClient.ts`.

- [ ] **Step 1: Write the failing tests** — `getAccountSpend` GETs `/api/spend?from=&to=` (bounds omitted when null); validates the array shape and rejects a malformed row through `AccountRequestError`; both `404 {error:"Not Found"}` and a non-JSON spend-route **404** → "does not support the spend API"; a non-JSON **5xx** stays a server error. Retain existing account-scope and server-message regression tests.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**
- Add `"spend"` to `type AccountRoute`.
- Give `request` one declarative options value and update existing POST calls to use it:
  ```ts
  type AccountRequestOptions = {
    body?: unknown;
    query?: Record<string, string>;
    unsupportedRouteMessage?: string;
  };

  async function request(
    method: "GET" | "POST",
    route: AccountRoute,
    options: AccountRequestOptions = {},
  ): Promise<unknown>;
  ```
- `accountRouteUrl` appends `options.query` as a search string; `request` remains the only fetch/auth/JSON/envelope/error implementation. POST serialization reads `options.body`.
- Preserve the account-scope 403 check first. Then, when `response.status === 404 && options.unsupportedRouteMessage !== undefined`, throw `AccountRequestError(options.unsupportedRouteMessage)` **before** the generic string-server-error branch. Existing routes pass no compatibility message and retain their current handling. Do not export an internal route-not-found class.
- `getAccountSpend`:
  ```ts
  async getAccountSpend(window) {
    const value = await request("GET", "spend", {
      query: toSpendQuery(window),
      unsupportedRouteMessage: "this statelog host does not support the spend API (upgrade the host)",
    });
    return parseValue(z.array(accountSpendRowSchema), value);
  }
  ```
  (Use the account client's existing `parseValue`, not `parseWire`.)
- Add `getAccountSpend` to the exported `AccountClient` type.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat(remote): accountClient.getAccountSpend`

---

### Task 5: Renderers + adaptive money formatting

**Files:**
- Modify: `lib/cli/remote/render.ts`
- Test: `lib/cli/remote/render.test.ts` (extend)

**Interfaces — Produces:** `renderProjectSpend(slug, spend, description)`, `renderAccountSpend(rows, description)`.

- [ ] **Step 1: Write the failing tests** (strip ANSI as the existing render tests do)

Cover: `renderProjectSpend` shows the `≥`/lower-bound note only when `usageComplete=false`, the `Unpriced` line only when `unpricedCallCount>0`; **zero cost → `$0.0000`; a tiny positive (`0.00004`) → `<$0.0001`** (separate cases); `renderAccountSpend`: assert the promised project/cost/token/invocation/unpriced headers and representative row values, active-by-cost-desc then deleted-by-cost-desc with `projectSlug` tie-break (assert equal-cost ordering), a correct `TOTAL`, and — with exactly one incomplete or unpriced row — a **visibly degraded total** (`≥` + summed unpriced note); empty array → `No projects yet.`

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** the `formatUsd`/`formatCount`/`lowerBound` helpers and the two renderers per the spec's File 5 section (using the existing `color` helper). Use descriptive names such as `amount`, `spend`, `rows`, and `totals`, never single-character production names. Keep each renderer focused; extract a `spendTotals(rows)` helper for the account aggregation (`Σ` cost/tokens/invocations/unpriced + `every(usageComplete)`).

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat(remote): render project + account spend`

---

### Task 6: The `spend` command + registration

**Files:**
- Create: `lib/cli/remote/commands/spend.ts`
- Test: `lib/cli/remote/commands/spend.test.ts`
- Modify: `scripts/agency.ts` (register `remote spend`)
- Modify: `scripts/agency.test.ts` (mock the recipe module, add `"spend"` to the asserted subcommand list, and test Commander forwarding)

**Interfaces:**
- Consumes: `resolveSpendWindow` (T2), both clients (T3/T4), renderers (T5), `resolveAccountTarget`/`resolveProjectTarget`/`failAccount`/`failProjectCommand`/`fail`/`printJson` (util).
- Produces: `SpendOptions = AccountCommandOptions & SpendWindowOptions & { json?: boolean }`, `runSpend(project, options, context)`.

- [ ] **Step 1: Write the failing test** (`spend.test.ts` — mirror `projects.test.ts`: hoisted mocks of BOTH `accountClient.js` and `projectClient.js`; `context()`; spy `console.log`, `process.exit`→throw, and `process.stdout.write` for `--json`)

Cover in `spend.test.ts`: no project → `getAccountSpend(window)` called, `renderAccountSpend` output logged; `<project>` → `createProjectClient(origin, "my-proj", key)` + `getSpend(window)`; an **invalid time flag** (e.g. `{ since: "banana" }`) → the thrown window error is converted to a `fail()` exit and **no client method is called**; account path with a project-scoped key surfaces the hint via `failAccount`; `--json` writes exactly the value via `process.stdout.write` and logs nothing else; the resolved `{from,to}` is passed to the client unchanged.

Cover in `scripts/agency.test.ts`:
- parse `remote spend my-project --since 7d --json --host https://h --api-key-env SPEND_KEY` and assert `runSpend` receives `"my-project"`, `{ since: "7d", json: true, host: "https://h", apiKeyEnv: "SPEND_KEY" }`, and the config context;
- parse bare `remote spend` and assert the positional argument is `undefined`;
- keep the sorted subcommand-name assertion.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** `spend.ts` per the spec's File 6 section (the `try { window = resolveSpendWindow(options) } catch { fail(...) }` boundary; positional `undefined` → account branch; else `resolveProjectTarget(context, { ...options, project })` and use `target.projectSlug`). Register in `scripts/agency.ts` per File 7. In `scripts/agency.test.ts`: add `runSpend` to `remoteRecipeMocks` + `vi.mock("@/cli/remote/commands/spend.js", …)`, insert `"spend"` into the expected sorted subcommand array (between `"pull"` and `"whoami"`), and add both Commander-forwarding cases from Step 1.

- [ ] **Step 4: Run to verify pass** — `pnpm test:run lib/cli/remote/commands/spend.test.ts scripts/agency.test.ts`.

- [ ] **Step 5: Commit** — `feat(remote): agency remote spend command`

---

### Task 7: Full verification + finish

- [ ] **Step 1: Typecheck** — `pnpm run typecheck` (main + tests + evals configs). Expected: clean. Fix any test-file type errors here, not after pushing.
- [ ] **Step 2: Full suite** — `pnpm test:run`. Expected: 0 failures (catches any untouched file that referenced the client/render surfaces).
- [ ] **Step 3: Optional manual smoke** — if a built CLI is handy, `pnpm run build` then `node dist/scripts/agency.js remote spend --help` to eyeball the flags. Not required for correctness (covered by the registration test).
- [ ] **Step 4: Prepare the branch for handoff** — Use superpowers:finishing-a-development-branch with base branch `main`. Present the available integration options; do not push or open a PR unless the user explicitly authorizes that shared action.

---

## Self-review notes (author)

- **Spec coverage:** T1 → File 1 (shared types); T2 → File 2 (window); T3/T4 → Files 3/4 (clients, 404 policy, query); T5 → File 5 (renderers, money); T6 → Files 6/7 (command, registration). Every spec test bullet maps to a step: window edge cases (T2), wire invariants + one-sided windows + 404 + 5xx regression (T3/T4/T1), money zero-vs-tiny + total degradation + sort (T5), scope + window-error→fail + `--json` (T6).
- **Type consistency:** `ProjectSpend`/`AccountSpendRow` inferred once in `spendTypes.ts`; `SpendWindow`/`toSpendQuery` shared by both clients; `ResolvedSpendWindow` flows command→renderer as `description`; `target.projectSlug` (not `.slug`); account client uses `parseValue`, project client `parseWire`.
- **Review points baked in:** positional-only scope (no `--project`/binding scope); pure returns-or-throws window with strict calendar validation and a `runSpend` `fail()` boundary; route-specific 404-only unsupported-host classification with JSON/non-JSON 404 and 5xx regression tests; `"spend"` added to the sealed `AccountRoute`; one query-capable request path per client; private compatibility mechanics; adaptive money; refined wire invariants; actual Commander forwarding coverage.
- **Anti-pattern check:** declarative domain interfaces remain the primary architecture. Request options replace positional placeholders, route markers stay private, no transport implementation is duplicated, production variables are descriptive, and all prescribed `if` statements use braces.
- **No codegen/docs:** CLI TS only; `docs/site/**` untouched.
