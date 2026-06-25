# Resilient LLM Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Implementation note (post-merge).** Several steps below add an
> `llmFailure` variant to the `AbortCause` union and assert on
> `agencyCause: { kind: "llmFailure" }`. **That variant was dropped during
> implementation**: the catch ladder re-throws any `AgencyAbort` (the
> propagate-never-swallow contract), so packaging the exhausted-retry error
> as an `AgencyAbort(llmFailure)` would have aborted the whole run instead
> of becoming a handleable `Failure`. The shipped behavior surfaces a plain
> `Error` carrying the `reason` and `detail` in its message; the
> function/node catch ladder converts it to a normal `Failure`. The only
> `AbortCause` variant added by this PR is `callTimeout` (the cause on the
> per-call `AbortController` while retrying). Treat every `llmFailure`
> reference below as historical — `lib/runtime/llmRetry.ts` and
> `lib/runtime/prompt.ts` are the source of truth.

**Goal:** Make `llm()` calls resilient — classify transient provider/transport failures, retry them with exponential backoff, impose an optional per-call timeout, and fire notification hooks — all in the backend so the happy path is unchanged.

**Architecture:** A thin retry loop in `lib/runtime/prompt.ts` wraps `dispatchLLMRequest`. The *policy* (retryable / terminal / abort? how long to back off?) lives in two pure functions in a new `lib/runtime/llmRetry.ts` — `classifyLlmError` and `decideRetry`. Crucially, classification is **provider-neutral**: it reads a `NormalizedLLMError` shape that the registered `LLMClient` produces, so retry policy never imports a provider SDK and keeps working when a user swaps smoltalk for another client. Each attempt is bounded by a call-scoped `AbortController`. Config reuses the existing `LlmDefaults` / `stack.other.llmDefaults` bag. No TS module globals.

**Tech Stack:** TypeScript runtime (`lib/runtime/*`), the `llm()` builtin (`lib/runtime/agencyLlm.ts`), the LLM-client abstraction (`lib/runtime/llmClient.ts`), `LlmDefaults` (`lib/stdlib/llm.ts`), the hook system (`lib/runtime/hooks.ts` + `lib/types/function.ts`), config (`lib/config.ts`). Tests via `pnpm test:run <file>` and `pnpm run a test js <dir>`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-resilient-llm-calls-design.md` is authoritative.
- **smoltalk 0.4.2 is installed** and exposes `status` / `headers` / `cause` on `SmolError`. Headers are an **allowlist** (most stripped for security), but `retry-after` / `retry-after-ms` / the `x-ratelimit-*` family ARE kept, so reading them works; the full raw headers are on `err.cause` if ever needed.
- **The LLM client is swappable** (`lib/runtime/llmClient.ts` — `LLMClient` interface, `SmoltalkClient` default, accessed as `ctx.llmClient`). Retry classification therefore must NOT import smoltalk; it reads a provider-neutral `NormalizedLLMError` the client adapter produces (Task 2).
- **Propagate-never-swallow (CLAUDE.md safety invariant):** the loop MUST re-throw any abort whose cause is a user/abort kind (`userInterrupt`, `userKill`, `guardTrip`, `raceLoser`, `cleanup`) immediately. A user cancel ALWAYS wins a race against our own `callTimeout`. Only provider/transport errors (and our `callTimeout`) are retry candidates.
- **Per-execution isolation:** no TS module-level mutable state. Config lives in `stack.other.llmDefaults` (branch-scoped, serialized, fork-inherited).
- **Defaults:** `retries: 2` (on), `timeout: 600000` ms = 10 min (on), `backoff: { initial: 500, factor: 2, max: 10000 }` (ms). `retries: 0` disables retry; `timeout: 0` disables the deadline.
- **Durations are ms numbers** by the time they reach TS (agency unit literals compile to ms, as `guard(time: 30s)` does).
- **Hook payload semantics (locked):** `onLLMRetry` carries `attempt` (1-based retry number) and `maxRetries` (the configured retry count) — "retry `attempt` of `maxRetries`".
- **Coding standards (enforced):** NO dynamic imports / `require(...)` — top-level `import` only (see `docs/dev/coding-standards.md`). Prefer `if` statements over ternaries. Write readable, multi-line code — do not cram multiple statements onto one line.
- **Build/test:** `make` before agency fixtures. Do NOT run the full agency suite locally — run targeted tests, save output to a file.

---

## File Structure

- `lib/runtime/errors.ts` — `callTimeout` + `llmFailure` in `AbortCause` (Task 1).
- `lib/runtime/llmClient.ts` — `NormalizedLLMError` type, `LLMClient.normalizeError?`, `SmoltalkClient.normalizeError` (Task 2). The ONLY file that imports the smoltalk error classes for this feature.
- `lib/runtime/llmRetry.ts` *(new)* — `LLMRetryReason`, `Classification`, `classifyLlmError` (neutral), `RetryPolicy`, `RetryDecision`, `decideRetry`, `resolveRetryPolicy` (Tasks 3, 6, 7).
- `lib/runtime/hooks.ts` + `lib/types/function.ts` — `onLLMRetry` / `onLLMTimeout` (Task 4).
- `lib/runtime/prompt.ts` — `armCallTimeout` + the retry loop (Tasks 5, 6).
- `lib/runtime/agencyLlm.ts` + `lib/stdlib/llm.ts` + `lib/config.ts` — `LlmOpts`/`LlmDefaults` knobs + `agency.json` defaults (Task 7).
- `tests/agency-js/llm-retry/`, `tests/agency-js/llm-timeout/` *(new)* — end-to-end (Task 8).
- `docs/site/guide/llm.md`, `docs/site/appendix/callbacks.md` — docs (Task 9).

---

## Task 0: Verify smoltalk 0.4.2 surface (already installed)

**Files:** none (sanity gate).

- [ ] **Step 1: Confirm the surface.** Run:

```bash
node --input-type=module -e 'import { SmolError } from "smoltalk"; const e = new SmolError("x", { status: 429, headers: { "retry-after": "3" }, cause: { raw: true } }); console.log(e.status, e.headers?.["retry-after"], JSON.stringify(e.cause));'
```

Expected: `429 3 {"raw":true}`. If this fails, resolve the smoltalk version before continuing. (No commit — the dependency is already at 0.4.2.)

---

## Task 1: Add `callTimeout` + `llmFailure` cause variants

**Files:**
- Modify: `lib/runtime/errors.ts` (the `AbortCause` union, ~line 52)
- Test: `lib/runtime/errors.test.ts`

**Interfaces:**
- Produces:
  - `{ kind: "callTimeout"; limitMs: number }`
  - `{ kind: "llmFailure"; reason: "connectionLost" | "streamInterrupted" | "rateLimit" | "serverError" | "overloaded"; detail: string; retryAfterMs?: number }`

- [ ] **Step 1: Write the failing test** — append to `lib/runtime/errors.test.ts`:

```ts
describe("LLM resilience causes", () => {
  it("round-trips callTimeout and llmFailure through readCause on an AgencyAbort", () => {
    const t = new AgencyAbort("t", makeAbortCause({ kind: "callTimeout", limitMs: 600000 }));
    expect(readCause(t)?.kind).toBe("callTimeout");
    expect((readCause(t) as { limitMs: number }).limitMs).toBe(600000);
    expect(isAbortError(t)).toBe(true);

    const f = new AgencyAbort(
      "f",
      makeAbortCause({
        kind: "llmFailure",
        reason: "rateLimit",
        detail: "429 too many requests",
        retryAfterMs: 12000,
      }),
    );
    const rc = readCause(f) as { reason: string; detail: string; retryAfterMs?: number };
    expect(rc.reason).toBe("rateLimit");
    expect(rc.detail).toBe("429 too many requests");
    expect(rc.retryAfterMs).toBe(12000);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/errors.test.ts` → FAIL (TS: new `kind`s not assignable).

- [ ] **Step 3: Implement** — in `lib/runtime/errors.ts`, after the `cleanup` member of `AbortCause`:

```ts
  | { kind: "raceLoser" }
  | { kind: "cleanup" }
  // An abort WE initiate when a single llm() call exceeds its per-call deadline.
  | { kind: "callTimeout"; limitMs: number }
  // A provider/transport failure we observed (surfaced after exhausting retries).
  // `detail` is the raw provider message; `retryAfterMs` is present when a server
  // retry-after was available. Never includes "timeout" (that is callTimeout).
  | {
      kind: "llmFailure";
      reason: "connectionLost" | "streamInterrupted" | "rateLimit" | "serverError" | "overloaded";
      detail: string;
      retryAfterMs?: number;
    };
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/errors.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/errors.ts lib/runtime/errors.test.ts && git commit -m "feat(errors): add callTimeout + llmFailure abort causes"`

---

## Task 2: Provider-neutral error abstraction (`NormalizedLLMError`)

**Files:**
- Modify: `lib/runtime/llmClient.ts` (add the type + the interface method + the `SmoltalkClient` impl)
- Test: `lib/runtime/llmClient.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `type NormalizedLLMError = { status?: number; retryAfterMs?: number; kind?: "contentPolicy" | "contextWindow" | "structuredOutput" | "requestTimeout"; message: string }`
  - `LLMClient.normalizeError?(err: unknown): NormalizedLLMError` — optional; a client without it falls back to `{ message }`.
  - `SmoltalkClient.normalizeError(err)` — the ONLY place that knows smoltalk's error classes.

> **Why:** the LLM client is swappable (`ctx.llmClient`). Retry classification (Task 3) must not import smoltalk, or a swapped-in client's errors would be unclassifiable. The client adapter — which already speaks one provider's protocol — translates its errors into these neutral fields; agency's classifier reads only those.

- [ ] **Step 1: Write the failing test** — `lib/runtime/llmClient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SmolError,
  SmolContentPolicyError,
  SmolContextWindowExceededError,
  SmolTimeoutError,
} from "smoltalk";
import { SmoltalkClient } from "./llmClient.js";

describe("SmoltalkClient.normalizeError", () => {
  const client = new SmoltalkClient();

  it("extracts status and retry-after from an HTTP SmolError", () => {
    const err = new SmolError("429 too many requests", {
      status: 429,
      headers: { "retry-after": "5" },
    });
    const n = client.normalizeError(err);
    expect(n.status).toBe(429);
    expect(n.retryAfterMs).toBe(5000);
    expect(n.kind).toBeUndefined();
    expect(n.message).toBe("429 too many requests");
  });

  it("prefers retry-after-ms when present", () => {
    const err = new SmolError("rate limited", {
      status: 429,
      headers: { "retry-after-ms": "2000" },
    });
    expect(client.normalizeError(err).retryAfterMs).toBe(2000);
  });

  it("maps typed terminal errors to a kind", () => {
    expect(client.normalizeError(new SmolContentPolicyError("blocked")).kind).toBe("contentPolicy");
    expect(client.normalizeError(new SmolContextWindowExceededError("too long")).kind).toBe("contextWindow");
    expect(client.normalizeError(new SmolTimeoutError("timed out")).kind).toBe("requestTimeout");
  });

  it("returns just the message for a non-smoltalk error", () => {
    const n = client.normalizeError(new Error("ECONNRESET"));
    expect(n).toEqual({ message: "ECONNRESET" });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmClient.test.ts` → FAIL (`normalizeError` not a function).

- [ ] **Step 3: Implement** — in `lib/runtime/llmClient.ts`:

```ts
import {
  SmolError,
  SmolContentPolicyError,
  SmolContextWindowExceededError,
  SmolStructuredOutputError,
  SmolTimeoutError,
} from "smoltalk";
```

```ts
/**
 * Provider-neutral view of an error thrown by an LLMClient. Lets agency's retry
 * classifier decide policy without importing any provider SDK. The client
 * adapter (which knows its provider's error shapes) populates this.
 */
export type NormalizedLLMError = {
  /** HTTP status, when the error came from an HTTP response. */
  status?: number;
  /** Server-requested retry delay (ms), parsed from response headers if present. */
  retryAfterMs?: number;
  /** Terminal-ish provider classifications the client recognizes. Undefined for
   *  generic / transport errors (agency falls back to status + message). */
  kind?: "contentPolicy" | "contextWindow" | "structuredOutput" | "requestTimeout";
  /** Human-readable message (always present). */
  message: string;
};
```

Add `normalizeError?(err: unknown): NormalizedLLMError;` to the `LLMClient` type. Implement it on `SmoltalkClient`:

```ts
  normalizeError(err: unknown): NormalizedLLMError {
    if (!(err instanceof SmolError)) {
      let message: string;
      if (err instanceof Error) {
        message = err.message;
      } else {
        message = String(err);
      }
      return { message };
    }

    const normalized: NormalizedLLMError = { message: err.message };
    if (err.status !== undefined) {
      normalized.status = err.status;
    }
    const retryAfterMs = parseRetryAfter(err.headers);
    if (retryAfterMs !== undefined) {
      normalized.retryAfterMs = retryAfterMs;
    }
    if (err instanceof SmolContentPolicyError) {
      normalized.kind = "contentPolicy";
    } else if (err instanceof SmolContextWindowExceededError) {
      normalized.kind = "contextWindow";
    } else if (err instanceof SmolStructuredOutputError) {
      normalized.kind = "structuredOutput";
    } else if (err instanceof SmolTimeoutError) {
      normalized.kind = "requestTimeout";
    }
    return normalized;
  }
```

```ts
function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) {
    return undefined;
  }
  const ms = headers["retry-after-ms"];
  if (ms !== undefined && !Number.isNaN(Number(ms))) {
    return Number(ms);
  }
  const seconds = headers["retry-after"];
  if (seconds !== undefined && !Number.isNaN(Number(seconds))) {
    return Number(seconds) * 1000;
  }
  return undefined;
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmClient.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/llmClient.ts lib/runtime/llmClient.test.ts && git commit -m "feat(llmClient): provider-neutral NormalizedLLMError abstraction"`

---

## Task 3: Classification + decision (`llmRetry.ts`) — pure, neutral

**Files:**
- Create: `lib/runtime/llmRetry.ts`
- Test: `lib/runtime/llmRetry.test.ts`

**Interfaces:**
- Consumes: `isAbortError`, `readCause` from `./errors.js`; `NormalizedLLMError` from `./llmClient.js`. (NO smoltalk import.)
- Produces:
  - `type LLMRetryReason = "timeout" | "connectionLost" | "streamInterrupted" | "rateLimit" | "serverError" | "overloaded"`
  - `type Classification = { kind: "retryable"; reason: LLMRetryReason; detail: string; retryAfterMs?: number } | { kind: "terminal"; detail: string } | { kind: "abort" }`
  - `classifyLlmError(err: unknown, normalized: NormalizedLLMError): Classification` — abort detection on the raw `err` (agency causes), provider classification from `normalized`.

- [ ] **Step 1: Write the failing test** — `lib/runtime/llmRetry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyLlmError } from "./llmRetry.js";
import { AgencyAbort, makeAbortCause } from "./errors.js";
import type { NormalizedLLMError } from "./llmClient.js";

describe("classifyLlmError", () => {
  it("our callTimeout is retryable with reason timeout", () => {
    const err = new AgencyAbort("t", makeAbortCause({ kind: "callTimeout", limitMs: 1000 }));
    const c = classifyLlmError(err, { message: "callTimeout" });
    expect(c).toMatchObject({ kind: "retryable", reason: "timeout" });
  });

  it("user / guard aborts classify as abort (never retried)", () => {
    const cancel = new AgencyAbort("c", makeAbortCause({ kind: "userInterrupt" }));
    expect(classifyLlmError(cancel, { message: "c" }).kind).toBe("abort");

    const trip = new AgencyAbort(
      "g",
      makeAbortCause({ kind: "guardTrip", dimension: "time", limit: 1, spent: 2, guardId: "g1" }),
    );
    expect(classifyLlmError(trip, { message: "g" }).kind).toBe("abort");
  });

  it("classifies HTTP errors by status", () => {
    const err = new Error("http");
    expect(classifyLlmError(err, { status: 429, retryAfterMs: 5000, message: "http" })).toMatchObject({
      kind: "retryable",
      reason: "rateLimit",
      retryAfterMs: 5000,
    });
    expect(classifyLlmError(err, { status: 529, message: "http" })).toMatchObject({ kind: "retryable", reason: "overloaded" });
    expect(classifyLlmError(err, { status: 503, message: "http" })).toMatchObject({ kind: "retryable", reason: "serverError" });
    expect(classifyLlmError(err, { status: 400, message: "http" }).kind).toBe("terminal");
    expect(classifyLlmError(err, { status: 401, message: "http" }).kind).toBe("terminal");
  });

  it("typed terminal kinds classify as terminal", () => {
    expect(classifyLlmError(new Error("x"), { kind: "contentPolicy", message: "x" }).kind).toBe("terminal");
    expect(classifyLlmError(new Error("x"), { kind: "contextWindow", message: "x" }).kind).toBe("terminal");
  });

  it("the client's own requestTimeout is retryable (transport)", () => {
    expect(classifyLlmError(new Error("x"), { kind: "requestTimeout", message: "x" })).toMatchObject({
      kind: "retryable",
      reason: "connectionLost",
    });
  });

  it("message-matches status-less transport drops", () => {
    expect(classifyLlmError(new Error("ECONNRESET"), { message: "ECONNRESET" })).toMatchObject({
      kind: "retryable",
      reason: "connectionLost",
    });
    expect(classifyLlmError(new Error("terminated before response"), { message: "terminated before response" })).toMatchObject({
      kind: "retryable",
      reason: "streamInterrupted",
    });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/runtime/llmRetry.ts`:

```ts
import { isAbortError, readCause } from "./errors.js";
import type { NormalizedLLMError } from "./llmClient.js";

export type LLMRetryReason =
  | "timeout"
  | "connectionLost"
  | "streamInterrupted"
  | "rateLimit"
  | "serverError"
  | "overloaded";

export type Classification =
  | { kind: "retryable"; reason: LLMRetryReason; detail: string; retryAfterMs?: number }
  | { kind: "terminal"; detail: string }
  | { kind: "abort" };

// Transport drops arrive with no HTTP status (they fail below the response).
// Ordered most-specific-first. Matched on the lowercased message.
const TRANSPORT_PATTERNS: Array<[string, "connectionLost" | "streamInterrupted"]> = [
  ["stream ended", "streamInterrupted"],
  ["premature", "streamInterrupted"],
  ["terminated", "streamInterrupted"],
  ["http/2", "streamInterrupted"],
  ["econnreset", "connectionLost"],
  ["econnrefused", "connectionLost"],
  ["etimedout", "connectionLost"],
  ["enotfound", "connectionLost"],
  ["socket hang up", "connectionLost"],
  ["network connection was lost", "connectionLost"],
  ["network request failed", "connectionLost"],
  ["fetch failed", "connectionLost"],
  ["failed to fetch", "connectionLost"],
];

export function classifyLlmError(err: unknown, normalized: NormalizedLLMError): Classification {
  // 1. Our own per-call deadline: retryable, reason "timeout".
  const cause = readCause(err);
  if (cause?.kind === "callTimeout") {
    return { kind: "retryable", reason: "timeout", detail: `call exceeded ${cause.limitMs}ms` };
  }

  // 2. Any OTHER abort/cancel (userInterrupt / guardTrip / raceLoser / ...): re-throw untouched.
  if (isAbortError(err)) {
    return { kind: "abort" };
  }

  // 3. Terminal provider classifications the client recognized.
  if (
    normalized.kind === "contentPolicy" ||
    normalized.kind === "contextWindow" ||
    normalized.kind === "structuredOutput"
  ) {
    return { kind: "terminal", detail: normalized.message };
  }

  // 4. The provider SDK's own request timeout — the request didn't complete; retry.
  if (normalized.kind === "requestTimeout") {
    return { kind: "retryable", reason: "connectionLost", detail: normalized.message };
  }

  // 5. HTTP errors — classify by status.
  if (normalized.status !== undefined) {
    return classifyByStatus(normalized);
  }

  // 6. No status: a transport drop. Message-match.
  return classifyByMessage(normalized.message);
}

function classifyByStatus(normalized: NormalizedLLMError): Classification {
  const status = normalized.status as number;
  if (status === 429) {
    if (normalized.retryAfterMs !== undefined) {
      return { kind: "retryable", reason: "rateLimit", detail: normalized.message, retryAfterMs: normalized.retryAfterMs };
    }
    return { kind: "retryable", reason: "rateLimit", detail: normalized.message };
  }
  if (status === 529) {
    return { kind: "retryable", reason: "overloaded", detail: normalized.message };
  }
  if (status >= 500) {
    return { kind: "retryable", reason: "serverError", detail: normalized.message };
  }
  // Other 4xx (400 / 401 / 403 / ...): terminal.
  return { kind: "terminal", detail: normalized.message };
}

function classifyByMessage(message: string): Classification {
  const hay = message.toLowerCase();
  for (const [needle, reason] of TRANSPORT_PATTERNS) {
    if (hay.includes(needle)) {
      return { kind: "retryable", reason, detail: message };
    }
  }
  return { kind: "terminal", detail: message };
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts && git commit -m "feat(runtime): provider-neutral LLM error classifier"`

---

## Task 4: Add the `onLLMRetry` + `onLLMTimeout` hooks

**Files:**
- Modify: `lib/runtime/hooks.ts` (`CallbackMap`, ~line 25)
- Modify: `lib/types/function.ts` (`VALID_CALLBACK_NAMES`, ~line 25)
- Test: `lib/typechecker/callbackBodyInterrupts.test.ts`

**Interfaces:**
- Produces:
  - `onLLMRetry: { attempt: number; maxRetries: number; delayMs: number; reason: LLMRetryReason; detail: string }`
  - `onLLMTimeout: { limitMs: number; attempt: number }`

- [ ] **Step 1: Write the failing test** — extend `lib/typechecker/callbackBodyInterrupts.test.ts`:

```ts
it("accepts onLLMRetry / onLLMTimeout as valid callback names", () => {
  const errors = typecheckSource(`
    node main() {
      callback("onLLMRetry") as data {
        print("retry ${data.attempt}/${data.maxRetries}")
      }
      callback("onLLMTimeout") as data {
        print("timeout ${data.limitMs}")
      }
      return "ok"
    }
  `);
  const nameErrors = errors.filter((e) => /callback name/i.test(e.message));
  expect(nameErrors).toEqual([]);
});
```

(Use the existing `typecheckSource` helper in that file.)

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/typechecker/callbackBodyInterrupts.test.ts` → FAIL (unknown callback name).

- [ ] **Step 3a: Add the names** — append to `VALID_CALLBACK_NAMES` in `lib/types/function.ts`, after `"onThreadEnd"`:

```ts
  "onLLMRetry",
  "onLLMTimeout",
```

- [ ] **Step 3b: Add the payloads** — in `lib/runtime/hooks.ts`, add a top-level import and the `CallbackMap` members (next to `onLLMCallEnd`):

```ts
import type { LLMRetryReason } from "./llmRetry.js";
```

```ts
  onLLMRetry: {
    attempt: number; // 1-based retry number
    maxRetries: number; // the configured retry count
    delayMs: number;
    reason: LLMRetryReason;
    detail: string;
  };
  onLLMTimeout: { limitMs: number; attempt: number };
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/typechecker/callbackBodyInterrupts.test.ts` → PASS; `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit** — `git add lib/runtime/hooks.ts lib/types/function.ts lib/typechecker/callbackBodyInterrupts.test.ts && git commit -m "feat(hooks): add onLLMRetry + onLLMTimeout callbacks"`

---

## Task 5: Per-call timeout (`armCallTimeout`)

**Files:**
- Modify: `lib/runtime/prompt.ts` (helper near `markThreadCancelled`; export via `_internal`)
- Test: `lib/runtime/prompt.test.ts`

**Interfaces:**
- Produces: `armCallTimeout(parentSignal: AbortSignal | undefined, limitMs: number): { signal: AbortSignal | undefined; dispose: () => void }`. When `limitMs > 0`, `signal` aborts (carrying a `callTimeout` cause) after `limitMs`. When `limitMs <= 0`, returns `{ signal: parentSignal, dispose: () => {} }` (return type is `AbortSignal | undefined` — no cast).

- [ ] **Step 1: Write the failing test** — in `lib/runtime/prompt.test.ts` (add `armCallTimeout` to the `_internal` destructuring; add `import { vi } from "vitest";` and `import { readCause } from "./errors.js";` at the top if not present):

```ts
describe("armCallTimeout", () => {
  it("aborts with a callTimeout cause after limitMs", () => {
    vi.useFakeTimers();
    const { signal, dispose } = _internal.armCallTimeout(undefined, 1000);
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(signal!.aborted).toBe(true);
    expect(readCause(signal!)?.kind).toBe("callTimeout");
    expect((readCause(signal!) as { limitMs: number }).limitMs).toBe(1000);
    dispose();
    vi.useRealTimers();
  });

  it("limitMs <= 0 with no parent returns undefined (no cast lie)", () => {
    const { signal } = _internal.armCallTimeout(undefined, 0);
    expect(signal).toBeUndefined();
  });

  it("limitMs <= 0 with a parent passes it through", () => {
    const parent = new AbortController().signal;
    const { signal } = _internal.armCallTimeout(parent, 0);
    expect(signal).toBe(parent);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/prompt.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `lib/runtime/prompt.ts` (add `makeAbortCause` to the `./errors.js` import; add `armCallTimeout` to `_internal`):

```ts
function armCallTimeout(
  parentSignal: AbortSignal | undefined,
  limitMs: number,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (limitMs <= 0) {
    return { signal: parentSignal, dispose: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new AgencyCancelledError(
        `llm call exceeded ${limitMs}ms`,
        makeAbortCause({ kind: "callTimeout", limitMs }),
      ),
    );
  }, limitMs);

  let signal: AbortSignal;
  if (parentSignal) {
    signal = AbortSignal.any([parentSignal, controller.signal]);
  } else {
    signal = controller.signal;
  }

  return {
    signal,
    dispose: () => clearTimeout(timer),
  };
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/prompt.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/prompt.ts lib/runtime/prompt.test.ts && git commit -m "feat(prompt): call-scoped timeout (armCallTimeout)"`

---

## Task 6: `decideRetry` (pure) + the retry loop

**Files:**
- Modify: `lib/runtime/llmRetry.ts` (add `RetryPolicy`, `RetryDecision`, `decideRetry`)
- Modify: `lib/runtime/prompt.ts` (`runWithRetry` loop; wire into `runPrompt`)
- Test: `lib/runtime/llmRetry.test.ts`, `lib/runtime/prompt.test.ts`

**Interfaces:**
- Produces:
  - `type RetryPolicy = { retries: number; timeout: number; backoff: { initial: number; factor: number; max: number } }`
  - `type RetryDecision = { kind: "propagate" } | { kind: "terminal" } | { kind: "surfaceFailure"; reason: Exclude<LLMRetryReason, "timeout">; detail: string; retryAfterMs?: number } | { kind: "retry"; delayMs: number; reason: LLMRetryReason; detail: string }`
  - `decideRetry(err: unknown, normalized: NormalizedLLMError, attempt: number, policy: RetryPolicy): RetryDecision` — pure.
  - `runWithRetry<T>(dispatch, policy, parentSignal, hooks, normalizeError)` on `prompt.ts` `_internal`.

- [ ] **Step 1: Write the failing `decideRetry` test** — in `lib/runtime/llmRetry.test.ts`:

```ts
import { decideRetry } from "./llmRetry.js";

const policy = { retries: 2, timeout: 0, backoff: { initial: 100, factor: 2, max: 1000 } };

describe("decideRetry", () => {
  it("propagates user aborts", () => {
    const err = new AgencyAbort("c", makeAbortCause({ kind: "userInterrupt" }));
    expect(decideRetry(err, { message: "c" }, 0, policy).kind).toBe("propagate");
  });

  it("retries a transient error with exponential backoff", () => {
    const err = new Error("503");
    const normalized: NormalizedLLMError = { status: 503, message: "503" };
    expect(decideRetry(err, normalized, 0, policy)).toMatchObject({ kind: "retry", reason: "serverError", delayMs: 100 });
    expect(decideRetry(err, normalized, 1, policy)).toMatchObject({ kind: "retry", delayMs: 200 });
  });

  it("honors retry-after over computed backoff (capped at max)", () => {
    const err = new Error("429");
    const normalized: NormalizedLLMError = { status: 429, retryAfterMs: 5000, message: "429" };
    expect(decideRetry(err, normalized, 0, policy)).toMatchObject({ kind: "retry", reason: "rateLimit", delayMs: 1000 });
  });

  it("surfaces an llmFailure once attempts are exhausted", () => {
    const err = new Error("503");
    expect(decideRetry(err, { status: 503, message: "503" }, 2, policy)).toMatchObject({
      kind: "surfaceFailure",
      reason: "serverError",
    });
  });

  it("terminal errors surface as-is", () => {
    expect(decideRetry(new Error("400"), { status: 400, message: "400" }, 0, policy).kind).toBe("terminal");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL.

- [ ] **Step 3: Implement `decideRetry`** in `lib/runtime/llmRetry.ts`:

```ts
export type RetryPolicy = {
  retries: number;
  timeout: number;
  backoff: { initial: number; factor: number; max: number };
};

export type RetryDecision =
  | { kind: "propagate" } // abort/cancel — re-throw err untouched
  | { kind: "terminal" } // terminal error or exhausted timeout — re-throw err (preserves its cause)
  | { kind: "surfaceFailure"; reason: Exclude<LLMRetryReason, "timeout">; detail: string; retryAfterMs?: number }
  | { kind: "retry"; delayMs: number; reason: LLMRetryReason; detail: string };

export function decideRetry(
  err: unknown,
  normalized: NormalizedLLMError,
  attempt: number,
  policy: RetryPolicy,
): RetryDecision {
  const c = classifyLlmError(err, normalized);
  if (c.kind === "abort") {
    return { kind: "propagate" };
  }
  if (c.kind === "terminal") {
    return { kind: "terminal" };
  }

  // c.kind === "retryable"
  if (attempt >= policy.retries) {
    // Exhausted. A timeout keeps its callTimeout cause (re-throw the original);
    // a provider error surfaces as a classified llmFailure.
    if (c.reason === "timeout") {
      return { kind: "terminal" };
    }
    return { kind: "surfaceFailure", reason: c.reason, detail: c.detail, retryAfterMs: c.retryAfterMs };
  }

  return { kind: "retry", delayMs: backoffMs(c, attempt, policy), reason: c.reason, detail: c.detail };
}

function backoffMs(
  c: { retryAfterMs?: number },
  attempt: number,
  policy: RetryPolicy,
): number {
  let base: number;
  if (c.retryAfterMs !== undefined) {
    base = c.retryAfterMs;
  } else {
    base = policy.backoff.initial * Math.pow(policy.backoff.factor, attempt);
  }
  return Math.min(base, policy.backoff.max);
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Write the failing loop tests** — in `lib/runtime/prompt.test.ts`. Add top-level imports (NO dynamic `require`):

```ts
import { SmolError } from "smoltalk";
import { AgencyCancelledError, makeAbortCause, readCause } from "./errors.js";
```

```ts
describe("runWithRetry", () => {
  const policy = { retries: 2, timeout: 0, backoff: { initial: 1, factor: 2, max: 10 } };
  const noHooks = { onRetry: async () => {}, onTimeout: async () => {} };
  // Test normalizer: read status off a SmolError, else just the message.
  const normalize = (err: unknown) => {
    if (err instanceof SmolError && err.status !== undefined) {
      return { status: err.status, message: err.message };
    }
    if (err instanceof Error) {
      return { message: err.message };
    }
    return { message: String(err) };
  };

  it("retries a transient error then succeeds; onLLMRetry fires per retry", async () => {
    let calls = 0;
    const fired: Array<{ attempt: number; maxRetries: number; reason: string; delayMs: number }> = [];
    const dispatch = async () => {
      if (calls < 2) {
        calls += 1;
        throw new Error("ECONNRESET");
      }
      return "ok";
    };
    const hooks = {
      onRetry: (d: { attempt: number; maxRetries: number; reason: string; delayMs: number }) => {
        fired.push(d);
      },
      onTimeout: async () => {},
    };

    const result = await _internal.runWithRetry(dispatch, policy, undefined, hooks, normalize);

    expect(result).toBe("ok");
    expect(fired.map((f) => f.reason)).toEqual(["connectionLost", "connectionLost"]);
    expect(fired[0]).toMatchObject({ attempt: 1, maxRetries: 2 });
    expect(fired[1].delayMs).toBeGreaterThanOrEqual(fired[0].delayMs);
  });

  it("surfaces an llmFailure after exhausting retries", async () => {
    const dispatch = async () => {
      throw new SmolError("503", { status: 503 });
    };

    await expect(
      _internal.runWithRetry(dispatch, policy, undefined, noHooks, normalize),
    ).rejects.toMatchObject({ agencyCause: { kind: "llmFailure", reason: "serverError" } });
  });

  it("#9 never swallows a user cancel during the backoff sleep", async () => {
    const ac = new AbortController();
    const dispatch = async () => {
      throw new Error("ECONNRESET");
    };
    const hooks = {
      onRetry: () => {
        ac.abort(new AgencyCancelledError(undefined, makeAbortCause({ kind: "userInterrupt" })));
      },
      onTimeout: async () => {},
    };

    const promise = _internal.runWithRetry(dispatch, policy, ac.signal, hooks, normalize);

    await expect(promise).rejects.toSatisfy((e: unknown) => readCause(e)?.kind === "userInterrupt");
  });

  it("#8 timeout with retries:0 fires onLLMTimeout once, no retry, surfaces", async () => {
    vi.useFakeTimers();
    const timeoutPolicy = { retries: 0, timeout: 20, backoff: policy.backoff };
    let timeouts = 0;
    const dispatch = (signal: AbortSignal | undefined) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    };
    const hooks = {
      onRetry: async () => {},
      onTimeout: () => {
        timeouts += 1;
      },
    };

    const promise = _internal.runWithRetry(dispatch, timeoutPolicy, undefined, hooks, normalize);
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).rejects.toSatisfy((e: unknown) => readCause(e)?.kind === "callTimeout");
    expect(timeouts).toBe(1);
    vi.useRealTimers();
  });

  it("#10 a retried timeout fires onLLMTimeout BEFORE onLLMRetry", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let calls = 0;
    const dispatch = (signal: AbortSignal | undefined) => {
      if (calls === 0) {
        calls += 1;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      }
      return Promise.resolve("ok");
    };
    const hooks = {
      onRetry: () => {
        order.push("retry");
      },
      onTimeout: () => {
        order.push("timeout");
      },
    };
    const timeoutPolicy = { retries: 1, timeout: 20, backoff: { initial: 1, factor: 2, max: 5 } };

    const promise = _internal.runWithRetry(dispatch, timeoutPolicy, undefined, hooks, normalize);
    await vi.advanceTimersByTimeAsync(30);
    await promise;

    expect(order).toEqual(["timeout", "retry"]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 6: Run, verify fail** — `pnpm test:run lib/runtime/prompt.test.ts` → FAIL (`runWithRetry` undefined).

- [ ] **Step 7: Implement the loop** — in `lib/runtime/prompt.ts`. Add top-level imports:

```ts
import { abortableSleep } from "../stdlib/abortable.js";
import { decideRetry } from "./llmRetry.js";
import type { RetryPolicy, LLMRetryReason } from "./llmRetry.js";
import type { NormalizedLLMError } from "./llmClient.js";
```

```ts
type RetryHooks = {
  onRetry: (d: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    reason: LLMRetryReason;
    detail: string;
  }) => void | Promise<void>;
  onTimeout: (d: { limitMs: number; attempt: number }) => void | Promise<void>;
};

async function runWithRetry<T>(
  dispatch: (signal: AbortSignal | undefined) => Promise<T>,
  policy: RetryPolicy,
  parentSignal: AbortSignal | undefined,
  hooks: RetryHooks,
  normalizeError: (err: unknown) => NormalizedLLMError,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const { signal, dispose } = armCallTimeout(parentSignal, policy.timeout);
    try {
      const result = await dispatch(signal);
      dispose();
      return result;
    } catch (err) {
      dispose();

      // The user (parent) abort ALWAYS wins a race with our own call timer.
      if (parentSignal?.aborted) {
        const parentCause = readCause(parentSignal);
        if (parentCause && parentCause.kind !== "callTimeout") {
          throw err;
        }
      }

      const cause = readCause(err);
      if (cause?.kind === "callTimeout") {
        await hooks.onTimeout({ limitMs: cause.limitMs, attempt });
      }

      const normalized = normalizeError(err);
      const decision = decideRetry(err, normalized, attempt, policy);

      if (decision.kind === "propagate" || decision.kind === "terminal") {
        throw err;
      }
      if (decision.kind === "surfaceFailure") {
        throw new AgencyCancelledError(
          decision.detail,
          makeAbortCause({
            kind: "llmFailure",
            reason: decision.reason,
            detail: decision.detail,
            retryAfterMs: decision.retryAfterMs,
          }),
        );
      }

      // decision.kind === "retry"
      await hooks.onRetry({
        attempt: attempt + 1,
        maxRetries: policy.retries,
        delayMs: decision.delayMs,
        reason: decision.reason,
        detail: decision.detail,
      });
      await abortableSleep(decision.delayMs, parentSignal); // Esc during the wait throws → aborts the loop
    }
  }
}
```

Export `runWithRetry` on `_internal`.

- [ ] **Step 8: Run, verify pass** — `pnpm test:run lib/runtime/prompt.test.ts lib/runtime/llmRetry.test.ts` → PASS. Save to `/tmp/task6.log`.

- [ ] **Step 9: Wire into `runPrompt`** — add `retryPolicy: RetryPolicy` to `runPrompt`'s args type. Replace the existing `dispatchLLMRequest` call (~line 229) with `runWithRetry`:
  - `dispatch(signal)` rebuilds `promptConfig` with `abortSignal: signal` and calls `dispatchLLMRequest`.
  - `normalizeError` = a small local helper that calls the client's normalizer with a fallback:

```ts
const normalizeError = (err: unknown): NormalizedLLMError => {
  if (ctx.llmClient.normalizeError) {
    return ctx.llmClient.normalizeError(err);
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err) };
};
```

  - hooks call `callHook({ ctx, name: "onLLMRetry", data })` / `"onLLMTimeout"`. Keep the existing outer `catch` (dispatch normalization) — `runWithRetry` re-throws aborts and surfaces `AgencyCancelledError(llmFailure)`, both already handled by that catch (the `llmFailure` is an `AgencyAbort` → re-thrown → converted to a Failure by the function/node catch ladder, as today).

- [ ] **Step 10: Build + run + commit** — `make`; re-run the unit tests; save output. `git add lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts lib/runtime/prompt.ts lib/runtime/prompt.test.ts && git commit -m "feat(prompt): retry loop (pure decideRetry) + per-call timeout + hooks"`

---

## Task 7: Config knobs via `LlmDefaults` (reuse, don't duplicate)

**Files:**
- Modify: `lib/stdlib/llm.ts` (`LlmDefaults` type, ~line 10)
- Modify: `lib/runtime/agencyLlm.ts` (`LlmOpts`, the `runPrompt` call)
- Modify: `lib/runtime/llmRetry.ts` (`resolveRetryPolicy`)
- Modify: `lib/config.ts` (`AgencyConfig.llm`, ~line 28)
- Test: `lib/runtime/llmRetry.test.ts`

**Interfaces:**
- Produces: `resolveRetryPolicy(opts, branchDefaults): RetryPolicy` — precedence per-call `opts` → `branchDefaults` (= `stack.other.llmDefaults`, seeded from `agency.json`, updated by `setLlmOptions`) → built-in default. `LlmOpts` and `LlmDefaults` both gain `retries?`, `timeout?`, `backoff?`.

> **Why `LlmDefaults`, not a new `RuntimeContext` field:** `model`/`temperature`/etc. already flow through `LlmDefaults` (`lib/stdlib/llm.ts`) on the branch-scoped, serialized `stack.other.llmDefaults` bag (read by `runPrompt:471`, fork-inherited via `runBatch`). Retry/timeout/backoff are siblings — a parallel mechanism would be two sources of truth.

- [ ] **Step 1: Write the failing test** — in `lib/runtime/llmRetry.test.ts`:

```ts
import { resolveRetryPolicy } from "./llmRetry.js";

describe("resolveRetryPolicy", () => {
  it("built-in defaults when nothing is set", () => {
    expect(resolveRetryPolicy({}, {})).toEqual({
      retries: 2,
      timeout: 600000,
      backoff: { initial: 500, factor: 2, max: 10000 },
    });
  });

  it("per-call overrides branch defaults overrides built-in", () => {
    const resolved = resolveRetryPolicy({ retries: 1 }, { retries: 5, timeout: 1000 });
    expect(resolved).toMatchObject({ retries: 1, timeout: 1000 });
  });

  it("retries:0 and timeout:0 disable", () => {
    const resolved = resolveRetryPolicy({ retries: 0, timeout: 0 }, {});
    expect(resolved.retries).toBe(0);
    expect(resolved.timeout).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL.

- [ ] **Step 3: Implement `resolveRetryPolicy`** in `lib/runtime/llmRetry.ts`:

```ts
type RetryConfig = {
  retries?: number;
  timeout?: number;
  backoff?: { initial?: number; factor?: number; max?: number };
};

const DEFAULTS: RetryPolicy = {
  retries: 2,
  timeout: 600000, // 10 min
  backoff: { initial: 500, factor: 2, max: 10000 },
};

function firstDefined<T>(...values: Array<T | undefined>): T {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  // The last argument is always a defined default, so this is unreachable.
  return values[values.length - 1] as T;
}

export function resolveRetryPolicy(opts: RetryConfig, branchDefaults: RetryConfig): RetryPolicy {
  return {
    retries: firstDefined(opts.retries, branchDefaults.retries, DEFAULTS.retries),
    timeout: firstDefined(opts.timeout, branchDefaults.timeout, DEFAULTS.timeout),
    backoff: {
      initial: firstDefined(opts.backoff?.initial, branchDefaults.backoff?.initial, DEFAULTS.backoff.initial),
      factor: firstDefined(opts.backoff?.factor, branchDefaults.backoff?.factor, DEFAULTS.backoff.factor),
      max: firstDefined(opts.backoff?.max, branchDefaults.backoff?.max, DEFAULTS.backoff.max),
    },
  };
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Extend `LlmDefaults`** — in `lib/stdlib/llm.ts`, add to the `LlmDefaults` type:

```ts
  retries?: number;
  timeout?: number;
  backoff?: { initial?: number; factor?: number; max?: number };
```

(If `_setLlmOptions` lists keys explicitly rather than copying present keys generically, add the three there too.)

- [ ] **Step 6: Extend `LlmOpts` + resolve in `llm()`** — in `lib/runtime/agencyLlm.ts`, add the same three fields to `LlmOpts`, and resolve the policy:

```ts
const { stack } = getRuntimeContext();
const branchDefaults = (stack.other.llmDefaults as RetryConfig | undefined) ?? {};
const retryPolicy = resolveRetryPolicy(opts, branchDefaults);
return runPrompt({
  prompt,
  messages: thread,
  responseFormat: opts.schema,
  clientConfig,
  retryPolicy,
  checkpointInfo: agencyStore.getStore()?.callsite,
});
```

(`checkpointInfo` is already in this call and `runPrompt`'s signature — unchanged.)

- [ ] **Step 7: Add the `agency.json` block + seed it** — add to `AgencyConfig` (`lib/config.ts:28`):

```ts
  /** Default LLM resilience policy (per-call llm() options + setLlmOptions override these). */
  llm?: {
    retries?: number;
    timeout?: number;
    backoff?: { initial?: number; factor?: number; max?: number };
  };
```

Then seed `config.llm` as the lowest-precedence layer of `stack.other.llmDefaults` at run start — at the same point the root execution's `smoltalkDefaults` are applied from the loaded `AgencyConfig` (search the run/CLI path; merge `config.llm` into the root stack's `other.llmDefaults` before any node runs, so `setLlmOptions` and per-call opts layer on top). Keeping the bag the single source of truth is the goal.

- [ ] **Step 8: Build + typecheck + commit** — `make`; `npx tsc --noEmit` → 0 errors. `git add lib/stdlib/llm.ts lib/runtime/agencyLlm.ts lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts lib/config.ts && git commit -m "feat(llm): retries/timeout/backoff via LlmDefaults + agency.json"`

---

## Task 8: End-to-end agency-js tests

**Files:**
- Create: `tests/agency-js/llm-retry/{agent.agency,test.js,fixture.json,agency.json}`
- Create: `tests/agency-js/llm-timeout/{agent.agency,test.js,fixture.json,agency.json}`

**Interfaces:**
- Consumes: the `__setLLMClient` seam (see `tests/agency-js/tool-call-no-phantom-thread/test.js`). Callbacks cannot write enclosing node-locals (no closures), so the retry count is observed via the statelog (the same file's pattern), not a mutated local.

- [ ] **Step 1: Write the retry agent** — `tests/agency-js/llm-retry/agent.agency`:

```
node main() {
  callback("onLLMRetry") as data {
    emit("retry", { attempt: data.attempt })
  }
  return llm("ping", { retries: 3, backoff: { initial: 1ms, factor: 2, max: 5ms } })
}
```

- [ ] **Step 2: Write the driver** — `tests/agency-js/llm-retry/test.js` (top-level imports only, no `require`): import `{ main, __setLLMClient }` from `./agent.js`; set a client whose `text()` throws `Error("ECONNRESET")` on the first 2 calls then returns `"pong"`; unlink `statelog.log`; run `main()`; read `statelog.log`, count `emit`/`retry` events; write `{ data, retryCount }` to `__result.json`. Format the client multi-line:

```js
let calls = 0;
const client = {
  async text() {
    if (calls < 2) {
      calls += 1;
      throw new Error("ECONNRESET");
    }
    return { success: true, value: { output: "pong", toolCalls: [], model: "test", usage: USAGE, cost: COST } };
  },
  async *textStream(config) {
    const r = await this.text(config);
    yield { type: "done", result: r.value };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};
```

- [ ] **Step 3: `fixture.json`** — `{ "data": "pong", "retryCount": 2 }`.

- [ ] **Step 4: Build + run** — `make`; `pnpm run a test js tests/agency-js/llm-retry` → PASS. Save to `/tmp/task8.log`.

- [ ] **Step 5: Timeout scenario** — `tests/agency-js/llm-timeout/`: the client's `text()` returns a promise that rejects only when its `signal` aborts (never resolves); the agent calls `llm("ping", { timeout: 20ms, retries: 0 })` inside `try`/`isFailure` (to make the failure observable) with an `onLLMTimeout` callback that `emit`s. Assert the run reports a failure AND exactly one `timeout` emit. The deterministic client receives the per-attempt `signal`, so the 20ms `armCallTimeout` fires deterministically.

- [ ] **Step 6: Commit** — `git add tests/agency-js/llm-retry tests/agency-js/llm-timeout && git commit -m "test(agency-js): end-to-end llm retry + timeout"`

---

## Task 9: Documentation

**Files:**
- Modify: `docs/site/guide/llm.md`, `docs/site/appendix/callbacks.md`

- [ ] **Step 1: Options** — in `llm.md`, add a "Resilience" section: `retries` / `timeout` / `backoff` with defaults (2 / 10min / 500ms×2 cap 10s), `retries: 0` / `timeout: 0` to disable, that they also work via `setLlmOptions` (per-branch) and the `agency.json` `llm` block, and that classification is provider-neutral (the client adapter surfaces status/kind; transport drops fall back to message).

- [ ] **Step 2: Hooks** — in `callbacks.md`, add `onLLMRetry` (`{ attempt, maxRetries, delayMs, reason, detail }`) and `onLLMTimeout` (`{ limitMs, attempt }`) to the hook list, noting they are side-effect-only.

- [ ] **Step 3: Commit** — `git add docs/site/guide/llm.md docs/site/appendix/callbacks.md && git commit -m "docs: llm resilience options + retry/timeout hooks"`

---

## Final verification

- [ ] `make` clean; `npx tsc --noEmit` → 0 errors.
- [ ] `pnpm test:run lib/runtime/errors.test.ts lib/runtime/llmClient.test.ts lib/runtime/llmRetry.test.ts lib/runtime/prompt.test.ts lib/typechecker/callbackBodyInterrupts.test.ts` → all green.
- [ ] `pnpm run a test js tests/agency-js/llm-retry tests/agency-js/llm-timeout` → green; save output.
- [ ] `pnpm run lint:structure` clean.
- [ ] Propagate-never-swallow: covered by the `runWithRetry` #9 test (user cancel during backoff re-throws) and `classifyLlmError`'s abort branch. Spot-check a `guard(time:)` wrapping a transiently-failing `llm()` still trips the guard.
- [ ] No dynamic `require` / `import()` anywhere added; no ternaries where an `if` reads better.
- [ ] Open the PR; note it depends on smoltalk 0.4.2.

## Notes for the implementer

- **Streaming:** `dispatchLLMRequest` handles both modes; the loop wraps it. Verify a failed streaming attempt does NOT leave partial assistant text on the thread before a retry (if it does, the dispatch wrapper must clear it — check how `handleStreamingResponse` appends streamed content on error).
- **Cost:** a failed transport attempt should not charge; confirm post-call accounting runs only on the successful attempt (it is downstream of `dispatchLLMRequest` returning).
- **A custom (non-smoltalk) LLMClient** that doesn't implement `normalizeError` still works: classification falls back to `{ message }` → message-matching only (status-based reasons unavailable, which is correct — that client surfaced no status).
