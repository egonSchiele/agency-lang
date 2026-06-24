# Resilient LLM Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `llm()` calls resilient — classify transient provider/transport failures, retry them with exponential backoff, impose an optional per-call timeout, and fire notification hooks — all in the backend so the happy path is unchanged.

**Architecture:** A thin retry loop in `lib/runtime/prompt.ts` wraps `dispatchLLMRequest`. The *policy* (is this error retryable/terminal/an-abort? how long to back off?) lives in two pure, exhaustively-testable functions in a new `lib/runtime/llmRetry.ts` — `classifyLlmError` (a 3-way discriminant) and `decideRetry`. Each attempt is bounded by a call-scoped `AbortController` (a mini-`TimeGuard`). On exhaustion the loop throws an `AgencyAbort` carrying a `callTimeout` or `llmFailure` cause. Per-call/per-branch config reuses the existing `LlmDefaults` / `stack.other.llmDefaults` bag (the same path `model`/`temperature` use). No TS module globals.

**Tech Stack:** TypeScript runtime (`lib/runtime/*`), the `llm()` builtin (`lib/runtime/agencyLlm.ts`), `LlmDefaults` (`lib/stdlib/llm.ts`), the hook system (`lib/runtime/hooks.ts` + `lib/types/function.ts`), config (`lib/config.ts`), smoltalk error classes. Tests via `pnpm test:run <file>` and `pnpm run a test js <dir>`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-resilient-llm-calls-design.md` is authoritative.
- **Assumes smoltalk PR #15 has landed** (`status`/`headers`/`cause` on `SmolError`). Task 0 bumps the dependency. Classification is **status-first** (HTTP errors via `err.status` + `err.headers`), **message-fallback** for status-less transport drops (ECONNRESET etc.). Agency catches no raw provider `APIError`s, so #15's APIError-wrapping behavior change is safe.
- **Propagate-never-swallow (CLAUDE.md safety invariant):** the loop MUST re-throw any abort whose cause is a user/abort kind (`userInterrupt`, `userKill`, `guardTrip`, `raceLoser`, `cleanup`) immediately — never classify, retry, or convert it. A user cancel ALWAYS wins a race against our own `callTimeout`. Only provider/transport errors (and our `callTimeout`) are retry candidates.
- **Per-execution isolation:** no TS module-level mutable state; signals/controllers are locals or on the per-run `StateStack`. Config lives in `stack.other.llmDefaults` (branch-scoped, serialized, fork-inherited).
- **Defaults:** `retries: 2` (on), `timeout: 600000` ms = 10 min (on), `backoff: { initial: 500, factor: 2, max: 10000 }` (ms). `retries: 0` disables retry; `timeout: 0` disables the deadline.
- **Durations are ms numbers** by the time they reach TS (agency unit literals compile to ms, as `guard(time: 30s)` does).
- **Hook payload semantics (locked):** `onLLMRetry` carries `attempt` (1-based retry number) and `maxRetries` (the configured retry count) — read it as "retry `attempt` of `maxRetries`". NOT total attempts.
- **Build/test:** `make` before agency fixtures. Do NOT run the full agency suite locally — run targeted tests, save output to a file.

---

## File Structure

- `package.json` — bump smoltalk to the PR #15 version (Task 0).
- `lib/runtime/errors.ts` — `callTimeout` + `llmFailure` in `AbortCause` (Task 1).
- `lib/runtime/llmRetry.ts` *(new)* — `LLMRetryReason`, `classifyLlmError` (3-way), `decideRetry`, `resolveRetryPolicy`, `RetryPolicy` (Tasks 2, 5, 6).
- `lib/runtime/hooks.ts` + `lib/types/function.ts` — `onLLMRetry` / `onLLMTimeout` (Task 3).
- `lib/runtime/prompt.ts` — `armCallTimeout` + the retry loop wrapping `dispatchLLMRequest` (Tasks 4, 5).
- `lib/runtime/agencyLlm.ts` + `lib/stdlib/llm.ts` + `lib/config.ts` — `LlmOpts`/`LlmDefaults` knobs, `agency.json` `llm` defaults (Task 6).
- `tests/agency-js/llm-retry/`, `tests/agency-js/llm-timeout/` *(new)* — end-to-end (Task 7).
- `docs/site/guide/llm.md`, `docs/site/appendix/callbacks.md` — docs (Task 8).

---

## Task 0: Bump smoltalk to the status/headers version (PR #15)

**Files:**
- Modify: `package.json` (the `smoltalk` dependency)

- [ ] **Step 1: Bump + install** — set the `smoltalk` version to the release that includes PR #15 ("Expose HTTP status and headers on SmolError"); run `pnpm install`.

- [ ] **Step 2: Verify the surface** — confirm `status`/`headers` exist:

```bash
node -e 'const {SmolError}=require("smoltalk"); const e=new SmolError("x",{status:429,headers:{"retry-after":"3"}}); console.log(e.status, e.headers["retry-after"])'
```

Expected: `429 3`. If this errors, #15 is not in the installed version — stop and resolve the dependency before continuing.

- [ ] **Step 3: Commit** — `git add package.json pnpm-lock.yaml && git commit -m "chore: bump smoltalk for SmolError status/headers (PR #15)"`

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

    const f = new AgencyAbort("f", makeAbortCause({
      kind: "llmFailure", reason: "rateLimit", detail: "429 too many requests", retryAfterMs: 12000,
    }));
    const rc = readCause(f) as { reason: string; detail: string; retryAfterMs?: number };
    expect(rc.reason).toBe("rateLimit");
    expect(rc.detail).toBe("429 too many requests");
    expect(rc.retryAfterMs).toBe(12000);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/errors.test.ts` → FAIL (TS: the new `kind`s aren't assignable).

- [ ] **Step 3: Implement** — in `lib/runtime/errors.ts`, after the `cleanup` member of `AbortCause`:

```ts
  | { kind: "raceLoser" }
  | { kind: "cleanup" }
  // An abort WE initiate when a single llm() call exceeds its per-call deadline.
  | { kind: "callTimeout"; limitMs: number }
  // A provider/transport failure we observed (surfaced after exhausting retries).
  // `detail` is the raw provider message; `retryAfterMs` is present when a server
  // retry-after was available (rateLimit) — never includes "timeout" (that is callTimeout).
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

## Task 2: Classification + policy (`llmRetry.ts`) — pure, 3-way

**Files:**
- Create: `lib/runtime/llmRetry.ts`
- Test: `lib/runtime/llmRetry.test.ts`

**Interfaces:**
- Consumes: `isAbortError`, `readCause` from `./errors.js`; `SmolError`, `SmolContentPolicyError`, `SmolContextWindowExceededError`, `SmolStructuredOutputError` from `smoltalk`.
- Produces:
  - `type LLMRetryReason = "timeout" | "connectionLost" | "streamInterrupted" | "rateLimit" | "serverError" | "overloaded"`
  - `type Classification = { kind: "retryable"; reason: LLMRetryReason; detail: string; retryAfterMs?: number } | { kind: "terminal"; detail: string } | { kind: "abort" }`
  - `classifyLlmError(err: unknown): Classification` — the single source of truth. Returns `abort` ONLY for user/abort causes (re-throw untouched); `retryable` for transient HTTP/transport errors AND our `callTimeout`; `terminal` otherwise.

> **Why 3-way, not `| null`:** callers must distinguish "re-throw an abort untouched" from "surface a terminal error as a Failure" — collapsing both to `null` (the old plan) leaked that decision back to the loop. The discriminant keeps the loop a thin `switch`.

- [ ] **Step 1: Write the failing test** — `lib/runtime/llmRetry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyLlmError } from "./llmRetry.js";
import { AgencyAbort, makeAbortCause } from "./errors.js";
import { SmolError, SmolContentPolicyError } from "smoltalk";

const httpErr = (status: number, headers?: Record<string, string>) =>
  new SmolError(`http ${status}`, { status, headers });

describe("classifyLlmError", () => {
  it("our callTimeout is retryable with reason timeout", () => {
    const e = new AgencyAbort("t", makeAbortCause({ kind: "callTimeout", limitMs: 1000 }));
    const c = classifyLlmError(e);
    expect(c).toMatchObject({ kind: "retryable", reason: "timeout" });
  });
  it("user/guard aborts are abort (never retried)", () => {
    expect(classifyLlmError(new AgencyAbort("c", makeAbortCause({ kind: "userInterrupt" }))).kind).toBe("abort");
    expect(classifyLlmError(new AgencyAbort("g", makeAbortCause({
      kind: "guardTrip", dimension: "time", limit: 1, spent: 2, guardId: "g1" }))).kind).toBe("abort");
  });
  it("classifies HTTP errors by status", () => {
    expect(classifyLlmError(httpErr(429, { "retry-after": "5" }))).toMatchObject({ kind: "retryable", reason: "rateLimit", retryAfterMs: 5000 });
    expect(classifyLlmError(httpErr(529))).toMatchObject({ kind: "retryable", reason: "overloaded" });
    expect(classifyLlmError(httpErr(503))).toMatchObject({ kind: "retryable", reason: "serverError" });
    expect(classifyLlmError(httpErr(400)).kind).toBe("terminal");
    expect(classifyLlmError(httpErr(401)).kind).toBe("terminal");
  });
  it("message-matches status-less transport drops", () => {
    expect(classifyLlmError(new Error("ECONNRESET"))).toMatchObject({ kind: "retryable", reason: "connectionLost" });
    expect(classifyLlmError(new SmolError("terminated before response"))).toMatchObject({ kind: "retryable", reason: "streamInterrupted" });
  });
  it("typed terminal errors are terminal", () => {
    expect(classifyLlmError(new SmolContentPolicyError("blocked")).kind).toBe("terminal");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/runtime/llmRetry.ts`:

```ts
import { isAbortError, readCause } from "./errors.js";
import {
  SmolError,
  SmolContentPolicyError,
  SmolContextWindowExceededError,
  SmolStructuredOutputError,
} from "smoltalk";

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

export function classifyLlmError(err: unknown): Classification {
  const detail = err instanceof Error ? err.message : String(err);

  // 1. Our own per-call deadline: retryable, reason "timeout".
  if (readCause(err)?.kind === "callTimeout") {
    const limitMs = (readCause(err) as { limitMs: number }).limitMs;
    return { kind: "retryable", reason: "timeout", detail: `call exceeded ${limitMs}ms` };
  }
  // 2. Any OTHER abort/cancel (userInterrupt / guardTrip / raceLoser / …): re-throw untouched.
  if (isAbortError(err)) return { kind: "abort" };
  // 3. Typed terminal provider errors.
  if (
    err instanceof SmolContentPolicyError ||
    err instanceof SmolContextWindowExceededError ||
    err instanceof SmolStructuredOutputError
  ) {
    return { kind: "terminal", detail };
  }
  // 4. HTTP errors — classify by status (smoltalk PR #15).
  const status = err instanceof SmolError ? err.status : undefined;
  if (typeof status === "number") {
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(err as SmolError);
      return retryAfterMs !== undefined
        ? { kind: "retryable", reason: "rateLimit", detail, retryAfterMs }
        : { kind: "retryable", reason: "rateLimit", detail };
    }
    if (status === 529) return { kind: "retryable", reason: "overloaded", detail };
    if (status >= 500) return { kind: "retryable", reason: "serverError", detail };
    return { kind: "terminal", detail }; // other 4xx (400/401/403/…)
  }
  // 5. No status → transport drop. Message-match.
  const hay = detail.toLowerCase();
  for (const [needle, reason] of TRANSPORT_PATTERNS) {
    if (hay.includes(needle)) return { kind: "retryable", reason, detail };
  }
  return { kind: "terminal", detail };
}

function parseRetryAfter(err: SmolError): number | undefined {
  const h = err.headers ?? {};
  const ms = h["retry-after-ms"];
  if (ms !== undefined && !Number.isNaN(Number(ms))) return Number(ms);
  const sec = h["retry-after"];
  if (sec !== undefined && !Number.isNaN(Number(sec))) return Number(sec) * 1000;
  return undefined;
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts && git commit -m "feat(runtime): 3-way LLM error classifier (status-first)"`

---

## Task 3: Add the `onLLMRetry` + `onLLMTimeout` hooks

**Files:**
- Modify: `lib/runtime/hooks.ts` (`CallbackMap`, ~line 25)
- Modify: `lib/types/function.ts` (`VALID_CALLBACK_NAMES`, ~line 25)
- Test: `lib/typechecker/callbackBodyInterrupts.test.ts`

**Interfaces:**
- Produces (payloads, semantics locked per Global Constraints):
  - `onLLMRetry: { attempt: number; maxRetries: number; delayMs: number; reason: LLMRetryReason; detail: string }`
  - `onLLMTimeout: { limitMs: number; attempt: number }`

- [ ] **Step 1: Write the failing test** — extend `lib/typechecker/callbackBodyInterrupts.test.ts`:

```ts
it("accepts onLLMRetry / onLLMTimeout as valid callback names", () => {
  const errors = typecheckSource(`
    node main() {
      callback("onLLMRetry") as data { print("retry ${data.attempt}/${data.maxRetries}") }
      callback("onLLMTimeout") as data { print("timeout ${data.limitMs}") }
      return "ok"
    }
  `);
  expect(errors.filter((e) => /callback name/i.test(e.message))).toEqual([]);
});
```

(Use the existing `typecheckSource` helper in that file.)

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/typechecker/callbackBodyInterrupts.test.ts` → FAIL (unknown callback name).

- [ ] **Step 3a: Add the names** — append to `VALID_CALLBACK_NAMES` in `lib/types/function.ts` (after `"onThreadEnd"`):

```ts
  "onLLMRetry",
  "onLLMTimeout",
```

- [ ] **Step 3b: Add the payloads** — in `lib/runtime/hooks.ts`, import the reason type and add to `CallbackMap` (next to `onLLMCallEnd`):

```ts
import type { LLMRetryReason } from "./llmRetry.js";
// ...
  onLLMRetry: {
    attempt: number;     // 1-based retry number
    maxRetries: number;  // the configured retry count
    delayMs: number;
    reason: LLMRetryReason;
    detail: string;
  };
  onLLMTimeout: { limitMs: number; attempt: number };
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/typechecker/callbackBodyInterrupts.test.ts` → PASS; `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit** — `git add lib/runtime/hooks.ts lib/types/function.ts lib/typechecker/callbackBodyInterrupts.test.ts && git commit -m "feat(hooks): add onLLMRetry + onLLMTimeout callbacks"`

---

## Task 4: Per-call timeout (`armCallTimeout`)

**Files:**
- Modify: `lib/runtime/prompt.ts` (helper near `markThreadCancelled`; export via `_internal`)
- Test: `lib/runtime/prompt.test.ts`

**Interfaces:**
- Produces: `armCallTimeout(parentSignal: AbortSignal | undefined, limitMs: number): { signal: AbortSignal | undefined; dispose: () => void }`. When `limitMs > 0`, `signal` aborts (carrying a `callTimeout` cause) after `limitMs`. When `limitMs <= 0`, returns `{ signal: parentSignal, dispose: () => {} }` (note the return type is `AbortSignal | undefined`, matching the dispatch slot — no `as AbortSignal` cast).

- [ ] **Step 1: Write the failing test** — in `lib/runtime/prompt.test.ts` (add `armCallTimeout` to the `_internal` destructuring; import `readCause`):

```ts
import { vi } from "vitest";
import { readCause } from "./errors.js";

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
    expect(_internal.armCallTimeout(undefined, 0).signal).toBeUndefined();
  });
  it("limitMs <= 0 with a parent passes it through", () => {
    const parent = new AbortController().signal;
    expect(_internal.armCallTimeout(parent, 0).signal).toBe(parent);
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
  if (limitMs <= 0) return { signal: parentSignal, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new AgencyCancelledError(
        `llm call exceeded ${limitMs}ms`,
        makeAbortCause({ kind: "callTimeout", limitMs }),
      ),
    );
  }, limitMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/prompt.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/prompt.ts lib/runtime/prompt.test.ts && git commit -m "feat(prompt): call-scoped timeout (armCallTimeout)"`

---

## Task 5: `decideRetry` (pure) + the retry loop

**Files:**
- Modify: `lib/runtime/llmRetry.ts` (add `RetryPolicy`, `RetryDecision`, `decideRetry`)
- Modify: `lib/runtime/prompt.ts` (`runWithRetry` loop; wire into `runPrompt`)
- Test: `lib/runtime/llmRetry.test.ts` (decideRetry — pure), `lib/runtime/prompt.test.ts` (loop)

**Interfaces:**
- Produces:
  - `type RetryPolicy = { retries: number; timeout: number; backoff: { initial: number; factor: number; max: number } }`
  - `type RetryDecision = { kind: "propagate" } | { kind: "terminal" } | { kind: "surfaceFailure"; reason: Exclude<LLMRetryReason, "timeout">; detail: string; retryAfterMs?: number } | { kind: "retry"; delayMs: number; reason: LLMRetryReason; detail: string }`
  - `decideRetry(err: unknown, attempt: number, policy: RetryPolicy): RetryDecision` — pure (no I/O, no hooks, no timers).
  - `runWithRetry<T>(dispatch, policy, parentSignal, hooks)` on `prompt.ts` `_internal`.

- [ ] **Step 1: Write the failing test for `decideRetry`** — in `lib/runtime/llmRetry.test.ts`:

```ts
import { decideRetry } from "./llmRetry.js";
import { AgencyAbort, makeAbortCause } from "./errors.js";
import { SmolError } from "smoltalk";
const policy = { retries: 2, timeout: 0, backoff: { initial: 100, factor: 2, max: 1000 } };

describe("decideRetry", () => {
  it("propagates user aborts", () => {
    expect(decideRetry(new AgencyAbort("c", makeAbortCause({ kind: "userInterrupt" })), 0, policy).kind).toBe("propagate");
  });
  it("retries a transient error with exponential backoff", () => {
    const d0 = decideRetry(new SmolError("503", { status: 503 }), 0, policy);
    const d1 = decideRetry(new SmolError("503", { status: 503 }), 1, policy);
    expect(d0).toMatchObject({ kind: "retry", reason: "serverError", delayMs: 100 });
    expect(d1).toMatchObject({ kind: "retry", delayMs: 200 });
  });
  it("honors retry-after over computed backoff (capped at max)", () => {
    const d = decideRetry(new SmolError("429", { status: 429, headers: { "retry-after": "5" } }), 0, policy);
    expect(d).toMatchObject({ kind: "retry", reason: "rateLimit", delayMs: 1000 }); // 5000 capped to max 1000
  });
  it("surfaces an llmFailure once attempts are exhausted", () => {
    expect(decideRetry(new SmolError("503", { status: 503 }), 2, policy)).toMatchObject({ kind: "surfaceFailure", reason: "serverError" });
  });
  it("terminal errors surface as-is", () => {
    expect(decideRetry(new SmolError("400", { status: 400 }), 0, policy).kind).toBe("terminal");
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
  | { kind: "propagate" }                                   // abort/cancel — re-throw err untouched
  | { kind: "terminal" }                                    // terminal error — re-throw err (becomes a Failure)
  | { kind: "surfaceFailure"; reason: Exclude<LLMRetryReason, "timeout">; detail: string; retryAfterMs?: number }
  | { kind: "retry"; delayMs: number; reason: LLMRetryReason; detail: string };

export function decideRetry(err: unknown, attempt: number, policy: RetryPolicy): RetryDecision {
  const c = classifyLlmError(err);
  if (c.kind === "abort") return { kind: "propagate" };
  if (c.kind === "terminal") return { kind: "terminal" };
  // retryable
  if (attempt >= policy.retries) {
    if (c.reason === "timeout") return { kind: "terminal" }; // exhausted timeout: keep the callTimeout cause (loop re-throws err)
    return { kind: "surfaceFailure", reason: c.reason, detail: c.detail, retryAfterMs: c.retryAfterMs };
  }
  const delayMs = Math.min(
    c.retryAfterMs ?? policy.backoff.initial * Math.pow(policy.backoff.factor, attempt),
    policy.backoff.max,
  );
  return { kind: "retry", delayMs, reason: c.reason, detail: c.detail };
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Write the failing loop test** — in `lib/runtime/prompt.test.ts`:

```ts
describe("runWithRetry", () => {
  const policy = { retries: 2, timeout: 0, backoff: { initial: 1, factor: 2, max: 10 } };
  const noHooks = { onRetry: async () => {}, onTimeout: async () => {} };

  it("retries a transient error then succeeds; onLLMRetry fires per retry", async () => {
    let n = 0; const fired: any[] = [];
    const dispatch = async () => { if (n++ < 2) throw new Error("ECONNRESET"); return "ok"; };
    const res = await _internal.runWithRetry(dispatch, policy, undefined, {
      onRetry: (d: any) => fired.push(d), onTimeout: async () => {},
    });
    expect(res).toBe("ok");
    expect(fired.map((f) => f.reason)).toEqual(["connectionLost", "connectionLost"]);
    expect(fired[0]).toMatchObject({ attempt: 1, maxRetries: 2 });
    expect(fired[1].delayMs).toBeGreaterThanOrEqual(fired[0].delayMs);
  });

  it("surfaces an llmFailure after exhausting retries", async () => {
    const dispatch = async () => { throw new (require("smoltalk").SmolError)("503", { status: 503 }); };
    await expect(_internal.runWithRetry(dispatch, policy, undefined, noHooks))
      .rejects.toMatchObject({ agencyCause: { kind: "llmFailure", reason: "serverError" } });
  });

  it("#9 never swallows a user cancel during the backoff sleep", async () => {
    const ac = new AbortController();
    const dispatch = async () => { throw new Error("ECONNRESET"); };
    const p = _internal.runWithRetry(dispatch, policy, ac.signal, {
      onRetry: () => { ac.abort(new (require("./errors.js").AgencyCancelledError)(undefined,
        require("./errors.js").makeAbortCause({ kind: "userInterrupt" }))); },
      onTimeout: async () => {},
    });
    await expect(p).rejects.toSatisfy((e: any) => require("./errors.js").readCause(e)?.kind === "userInterrupt");
  });

  it("#8 timeout with retries:0 fires onLLMTimeout once, no retry, surfaces", async () => {
    vi.useFakeTimers();
    const timeoutPolicy = { retries: 0, timeout: 20, backoff: policy.backoff };
    let timeouts = 0;
    const dispatch = (signal: AbortSignal | undefined) =>
      new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    const p = _internal.runWithRetry(dispatch, timeoutPolicy, undefined, {
      onRetry: async () => {}, onTimeout: () => { timeouts++; },
    });
    await vi.advanceTimersByTimeAsync(20);
    await expect(p).rejects.toSatisfy((e: any) => require("./errors.js").readCause(e)?.kind === "callTimeout");
    expect(timeouts).toBe(1);
    vi.useRealTimers();
  });

  it("#10 a retried timeout fires onLLMTimeout BEFORE onLLMRetry", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let n = 0;
    const dispatch = (signal: AbortSignal | undefined) =>
      n++ === 0
        ? new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
        : Promise.resolve("ok");
    const p = _internal.runWithRetry(dispatch, { retries: 1, timeout: 20, backoff: { initial: 1, factor: 2, max: 5 } }, undefined, {
      onRetry: () => order.push("retry"), onTimeout: () => order.push("timeout"),
    });
    await vi.advanceTimersByTimeAsync(30);
    await p;
    expect(order).toEqual(["timeout", "retry"]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 6: Run, verify fail** — `pnpm test:run lib/runtime/prompt.test.ts` → FAIL (`runWithRetry` undefined).

- [ ] **Step 7: Implement the loop** — in `lib/runtime/prompt.ts` (imports: `abortableSleep` from `../stdlib/abortable.js`; `decideRetry`, `type RetryPolicy`, `type LLMRetryReason` from `./llmRetry.js`):

```ts
type RetryHooks = {
  onRetry: (d: { attempt: number; maxRetries: number; delayMs: number; reason: LLMRetryReason; detail: string }) => void | Promise<void>;
  onTimeout: (d: { limitMs: number; attempt: number }) => void | Promise<void>;
};

async function runWithRetry<T>(
  dispatch: (signal: AbortSignal | undefined) => Promise<T>,
  policy: RetryPolicy,
  parentSignal: AbortSignal | undefined,
  hooks: RetryHooks,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const { signal, dispose } = armCallTimeout(parentSignal, policy.timeout);
    try {
      const result = await dispatch(signal);
      dispose();
      return result;
    } catch (err) {
      dispose();
      // The user (parent) abort ALWAYS wins a race with our own call timer.
      if (parentSignal?.aborted) {
        const pc = readCause(parentSignal);
        if (pc && pc.kind !== "callTimeout") throw err;
      }
      const cause = readCause(err);
      if (cause?.kind === "callTimeout") {
        await hooks.onTimeout({ limitMs: cause.limitMs, attempt });
      }
      const d = decideRetry(err, attempt, policy);
      if (d.kind === "propagate" || d.kind === "terminal") throw err; // abort, or terminal/exhausted-timeout: keep original cause
      if (d.kind === "surfaceFailure") {
        throw new AgencyCancelledError(d.detail, makeAbortCause({
          kind: "llmFailure", reason: d.reason, detail: d.detail, retryAfterMs: d.retryAfterMs,
        }));
      }
      // retry
      await hooks.onRetry({ attempt: attempt + 1, maxRetries: policy.retries, delayMs: d.delayMs, reason: d.reason, detail: d.detail });
      await abortableSleep(d.delayMs, parentSignal); // Esc during the wait throws → aborts the loop
    }
  }
}
```

Export `runWithRetry` on `_internal`.

- [ ] **Step 8: Run, verify pass** — `pnpm test:run lib/runtime/prompt.test.ts lib/runtime/llmRetry.test.ts` → PASS. Save to `/tmp/task5.log`.

- [ ] **Step 9: Wire into `runPrompt`** — add `retryPolicy: RetryPolicy` to `runPrompt`'s args type. Replace the existing `dispatchLLMRequest` call (~line 229) with a `runWithRetry` whose `dispatch(signal)` rebuilds `promptConfig` with `abortSignal: signal` and calls `dispatchLLMRequest`, and whose hooks call `callHook({ ctx, name: "onLLMRetry", data })` / `"onLLMTimeout"`. Keep the existing outer `catch` (dispatch normalization) — `runWithRetry` re-throws aborts and surfaces `AgencyCancelledError(llmFailure)`, both of which that catch already handles (an `llmFailure` is an `AgencyAbort` → re-thrown by the abort rung → converted to a Failure by the function/node catch ladder, exactly as today).

- [ ] **Step 10: Build + targeted run** — `make`; re-run the unit tests; save output. Commit — `git add lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts lib/runtime/prompt.ts lib/runtime/prompt.test.ts && git commit -m "feat(prompt): retry loop (pure decideRetry) + per-call timeout + hooks"`

---

## Task 6: Config knobs via `LlmDefaults` (reuse, don't duplicate)

**Files:**
- Modify: `lib/stdlib/llm.ts` (`LlmDefaults` type, ~line 10)
- Modify: `lib/runtime/agencyLlm.ts` (`LlmOpts`, the `runPrompt` call)
- Modify: `lib/runtime/llmRetry.ts` (`resolveRetryPolicy`)
- Modify: `lib/config.ts` (`AgencyConfig.llm`, ~line 28)
- Test: `lib/runtime/llmRetry.test.ts`

**Interfaces:**
- Produces: `resolveRetryPolicy(opts, branchDefaults): RetryPolicy` — precedence per-call `opts` → `branchDefaults` (= `stack.other.llmDefaults`, which is seeded from `agency.json` and updated by `setLlmOptions`) → built-in default. `LlmOpts` and `LlmDefaults` both gain `retries?`, `timeout?`, `backoff?`.

> **Why `LlmDefaults`, not a new `RuntimeContext.getLlmConfig()`:** `model`/`temperature`/etc. already flow through `LlmDefaults` (`lib/stdlib/llm.ts`) on the branch-scoped, serialized `stack.other.llmDefaults` bag (set per-branch by `setLlmOptions`, read by `runPrompt:471`, fork-inherited via `runBatch`). Retry/timeout/backoff are siblings — adding a parallel `RuntimeContext` field would be two sources of truth. Reuse the bag.

- [ ] **Step 1: Write the failing test** — in `lib/runtime/llmRetry.test.ts`:

```ts
import { resolveRetryPolicy } from "./llmRetry.js";
describe("resolveRetryPolicy", () => {
  it("built-in defaults when nothing set", () => {
    expect(resolveRetryPolicy({}, {})).toEqual({
      retries: 2, timeout: 600000, backoff: { initial: 500, factor: 2, max: 10000 },
    });
  });
  it("per-call overrides branch defaults overrides built-in", () => {
    expect(resolveRetryPolicy({ retries: 1 }, { retries: 5, timeout: 1000 })).toMatchObject({ retries: 1, timeout: 1000 });
  });
  it("retries:0 / timeout:0 disable", () => {
    expect(resolveRetryPolicy({ retries: 0, timeout: 0 }, {})).toMatchObject({ retries: 0, timeout: 0 });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL.

- [ ] **Step 3: Implement `resolveRetryPolicy`** in `lib/runtime/llmRetry.ts`:

```ts
type RetryConfig = { retries?: number; timeout?: number; backoff?: { initial?: number; factor?: number; max?: number } };
const DEFAULTS: RetryPolicy = { retries: 2, timeout: 600000, backoff: { initial: 500, factor: 2, max: 10000 } };

export function resolveRetryPolicy(opts: RetryConfig, branchDefaults: RetryConfig): RetryPolicy {
  const pick = <T>(...vals: (T | undefined)[]) => vals.find((v) => v !== undefined)!;
  return {
    retries: pick(opts.retries, branchDefaults.retries, DEFAULTS.retries),
    timeout: pick(opts.timeout, branchDefaults.timeout, DEFAULTS.timeout),
    backoff: {
      initial: pick(opts.backoff?.initial, branchDefaults.backoff?.initial, DEFAULTS.backoff.initial),
      factor: pick(opts.backoff?.factor, branchDefaults.backoff?.factor, DEFAULTS.backoff.factor),
      max: pick(opts.backoff?.max, branchDefaults.backoff?.max, DEFAULTS.backoff.max),
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

(No change needed to `_setLlmOptions` if it shallow-copies present keys generically; if it lists keys explicitly, add the three.)

- [ ] **Step 6: Extend `LlmOpts` + resolve in `llm()`** — in `lib/runtime/agencyLlm.ts`, add the same three fields to `LlmOpts`, and pass the resolved policy to `runPrompt`:

```ts
  const { stack } = getRuntimeContext();
  const retryPolicy = resolveRetryPolicy(opts, (stack.other.llmDefaults as any) ?? {});
  return runPrompt({ prompt, messages: thread, responseFormat: opts.schema, clientConfig, retryPolicy, checkpointInfo: agencyStore.getStore()?.callsite });
```

(`checkpointInfo` is already part of this call and `runPrompt`'s signature — unchanged.)

- [ ] **Step 7: Seed `agency.json` defaults into `llmDefaults`** — add the config block to `AgencyConfig` (`lib/config.ts:28`):

```ts
  /** Default LLM resilience policy (per-call llm() options + setLlmOptions override these). */
  llm?: { retries?: number; timeout?: number; backoff?: { initial?: number; factor?: number; max?: number } };
```

Then seed it as the lowest-precedence layer of `stack.other.llmDefaults` at run start — wherever the root execution's `smoltalkDefaults` are applied (search the run/CLI path that constructs the context from the loaded `AgencyConfig`; merge `config.llm` into the root stack's `other.llmDefaults` before any node runs, so `setLlmOptions` and per-call opts layer on top). If a clean root-seed site isn't available, pass `config.llm` as a third argument to `resolveRetryPolicy` and document the 3-arg precedence — but prefer the seed so the bag stays the single source of truth.

- [ ] **Step 8: Build + typecheck** — `make`; `npx tsc --noEmit` → 0 errors. Commit — `git add lib/stdlib/llm.ts lib/runtime/agencyLlm.ts lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts lib/config.ts && git commit -m "feat(llm): retries/timeout/backoff via LlmDefaults + agency.json"`

---

## Task 7: End-to-end agency-js tests

**Files:**
- Create: `tests/agency-js/llm-retry/{agent.agency,test.js,fixture.json,agency.json}`
- Create: `tests/agency-js/llm-timeout/{agent.agency,test.js,fixture.json,agency.json}`

**Interfaces:**
- Consumes: the `__setLLMClient` seam (see `tests/agency-js/tool-call-no-phantom-thread/test.js`) + statelog counting (callbacks can NOT write enclosing node-locals — no closures — so count retries via the statelog, the same file's pattern).

- [ ] **Step 1: Write the retry agent** — `tests/agency-js/llm-retry/agent.agency`: an `onLLMRetry` callback that `emit`s a marker (statelog-visible), then `llm("ping", { retries: 3, backoff: { initial: 1ms, factor: 2, max: 5ms } })`, returns the answer:

```
node main() {
  callback("onLLMRetry") as data {
    emit("retry", { attempt: data.attempt })
  }
  return llm("ping", { retries: 3, backoff: { initial: 1ms, factor: 2, max: 5ms } })
}
```

- [ ] **Step 2: Write the driver** — `test.js` imports `{ main, __setLLMClient }`, sets a client whose `text()` throws `Error("ECONNRESET")` on the first 2 calls then returns `"pong"`, runs `main()`, reads `statelog.log` (unlink first, as in `tool-call-no-phantom-thread`), counts `emit`/`retry` events, writes `{ data, retryCount }` to `__result.json`.

- [ ] **Step 3: `fixture.json`** — `{ "data": "pong", "retryCount": 2 }`.

- [ ] **Step 4: Build + run** — `make`; `pnpm run a test js tests/agency-js/llm-retry` → PASS. Save to `/tmp/task7.log`.

- [ ] **Step 5: Timeout scenario** — `tests/agency-js/llm-timeout/`: client `text()` returns a promise that only rejects on its `signal` abort (never resolves); agent calls `llm("ping", { timeout: 20ms, retries: 0 })` with an `onLLMTimeout` callback that `emit`s. Assert the run surfaces a failure (the call is wrapped in `try`/`isFailure` in the agent to make it observable) AND exactly one `timeout` emit. The deterministic client receives the per-attempt `signal` — wire it to reject on abort so the 20ms `armCallTimeout` fires deterministically.

- [ ] **Step 6: Commit** — `git add tests/agency-js/llm-retry tests/agency-js/llm-timeout && git commit -m "test(agency-js): end-to-end llm retry + timeout"`

---

## Task 8: Documentation

**Files:**
- Modify: `docs/site/guide/llm.md`, `docs/site/appendix/callbacks.md`

- [ ] **Step 1: Options** — in `llm.md`, add a "Resilience" section: `retries` / `timeout` / `backoff` with defaults (2 / 10min / 500ms×2 cap 10s), `retries: 0` / `timeout: 0` to disable, that they also work via `setLlmOptions` (per-branch) and the `agency.json` `llm` block, and that classification uses provider status (rate-limit/server/overloaded) + message (connection drops).

- [ ] **Step 2: Hooks** — in `callbacks.md`, add `onLLMRetry` (`{ attempt, maxRetries, delayMs, reason, detail }`) and `onLLMTimeout` (`{ limitMs, attempt }`) to the hook list, noting they are side-effect-only.

- [ ] **Step 3: Commit** — `git add docs/site/guide/llm.md docs/site/appendix/callbacks.md && git commit -m "docs: llm resilience options + retry/timeout hooks"`

---

## Final verification

- [ ] `make` clean; `npx tsc --noEmit` → 0 errors.
- [ ] `pnpm test:run lib/runtime/errors.test.ts lib/runtime/llmRetry.test.ts lib/runtime/prompt.test.ts lib/typechecker/callbackBodyInterrupts.test.ts` → all green.
- [ ] `pnpm run a test js tests/agency-js/llm-retry tests/agency-js/llm-timeout` → green; save output.
- [ ] `pnpm run lint:structure` clean.
- [ ] Propagate-never-swallow: covered by the `runWithRetry` unit test (#9, user cancel during backoff re-throws) and `classifyLlmError`'s abort branch (guardTrip → `abort` → never retried). Spot-check a `guard(time:)` wrapping a transiently-failing `llm()` still trips the guard.
- [ ] Open the PR; note that this depends on smoltalk PR #15 (Task 0).

## Notes for the implementer

- **Streaming:** `dispatchLLMRequest` handles both modes; the loop wraps it. Verify a failed streaming attempt does NOT leave partial assistant text on the thread before a retry (if it does, the dispatch wrapper must clear it — check how `dispatchLLMRequest` appends streamed content on error).
- **Cost:** a failed transport attempt should not charge; confirm post-call accounting runs only on the successful attempt (it is downstream of `dispatchLLMRequest` returning).
- **callTimeout that exhausts retries** surfaces by re-throwing the original `callTimeout`-caused error (decision `terminal`), preserving its `limitMs` — it is NOT converted to an `llmFailure`.
