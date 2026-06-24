# Resilient LLM Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `llm()` calls resilient — classify transient provider/transport failures, retry them with exponential backoff, impose an optional per-call timeout, and fire notification hooks — all in the backend so the happy path is unchanged.

**Architecture:** A retry loop wraps the existing `dispatchLLMRequest` in `lib/runtime/prompt.ts`. Each attempt is bounded by a call-scoped `AbortController` (a mini-`TimeGuard`) for the timeout. A failed attempt is run through a message-pattern classifier; if transient and attempts remain, fire `onLLMRetry`, wait a cancellable backoff (`abortableSleep`), and re-issue. On exhaustion, throw an `AgencyAbort` carrying a `callTimeout` or `llmFailure` cause. All state lives on the per-execution `StateStack`/ALS frame — no TS module globals.

**Tech Stack:** TypeScript runtime (`lib/runtime/*`), the agency `llm()` builtin (`lib/runtime/agencyLlm.ts`), the callback/hook system (`lib/runtime/hooks.ts` + `lib/types/function.ts`), config (`lib/config.ts`). Tests via `pnpm test:run <file>` (unit) and `pnpm run a test js <dir>` (agency-js).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-resilient-llm-calls-design.md` is authoritative.
- **smoltalk exposes only `message`** on `SmolError` (and subclasses `SmolStructuredOutputError`, `SmolTimeoutError`, `SmolContentPolicyError`, `SmolContextWindowExceededError`) — NO HTTP status / headers / `retry-after`. Therefore classification is **message-pattern matching** (Pi's approach), and `retryAfterMs` is populated only if a value can be parsed from the message (usually absent). Honoring a precise server `retry-after` and reliably distinguishing `529` from `500` are **out of scope** (they need a smoltalk change); the reason enum is pruned accordingly — `overloaded` is best-effort by message, else `serverError`.
- **Propagate-never-swallow (CLAUDE.md safety invariant):** the retry loop MUST re-throw any `AgencyAbort` whose cause is a user/abort kind (`userInterrupt`, `userKill`, `guardTrip`, `raceLoser`, `cleanup`) immediately — never classify, retry, or convert it. Only provider/transport errors are candidates for retry.
- **Per-execution isolation:** the retry loop holds NO TS module-level mutable state. All signals/controllers live on the per-run `StateStack` or as locals; durations are plain numbers (ms).
- **Defaults:** `retries: 2` (on), `timeout: 600000` ms = 10 min (on), `backoff: { initial: 500, factor: 2, max: 10000 }` (ms). `retries: 0` disables retry; `timeout: 0` disables the deadline.
- **Durations are ms numbers** by the time they reach TS — agency unit literals (`10min`, `500ms`) compile to milliseconds exactly as `guard(time: 30s)` does.
- **Build/test:** `make` before running agency fixtures (copies `lib/agents` into `dist`). Unit tests: `pnpm test:run <file>`. Do NOT run the full agency suite locally — run targeted tests and save output to a file.

---

## File Structure

- `lib/runtime/errors.ts` — add `callTimeout` + `llmFailure` to the `AbortCause` union (Task 1).
- `lib/runtime/llmRetry.ts` *(new)* — pure classification + policy resolution: `LLMRetryReason`, `classifyLlmError`, `resolveRetryPolicy`, `computeBackoffMs` (Tasks 2, 6).
- `lib/runtime/hooks.ts` + `lib/types/function.ts` — the `onLLMRetry` / `onLLMTimeout` hooks (Task 3).
- `lib/runtime/prompt.ts` — the per-call timeout + the retry loop wrapping `dispatchLLMRequest` (Tasks 4, 5).
- `lib/runtime/agencyLlm.ts` + `lib/config.ts` — `LlmOpts` knobs, `agency.json` `llm` defaults, plumbing into `runPrompt` (Task 6).
- `tests/agency-js/llm-retry/` *(new)* — end-to-end deterministic-client integration test (Task 7).
- `docs/site/guide/llm.md`, `docs/site/appendix/callbacks.md` — docs (Task 8).

---

## Task 1: Add `callTimeout` + `llmFailure` cause variants

**Files:**
- Modify: `lib/runtime/errors.ts` (the `AbortCause` union, ~line 52)
- Test: `lib/runtime/errors.test.ts`

**Interfaces:**
- Produces: two new `AbortCause` members consumed by every later task:
  - `{ kind: "callTimeout"; limitMs: number }`
  - `{ kind: "llmFailure"; reason: "connectionLost" | "streamInterrupted" | "rateLimit" | "serverError" | "overloaded"; detail: string; retryAfterMs?: number }`

- [ ] **Step 1: Write the failing test** — append to `lib/runtime/errors.test.ts`:

```ts
describe("LLM resilience causes", () => {
  it("round-trips callTimeout and llmFailure through readCause", () => {
    const t = makeAbortCause({ kind: "callTimeout", limitMs: 600000 });
    expect(readCause(t)?.kind).toBe("callTimeout");
    expect((readCause(t) as { limitMs: number }).limitMs).toBe(600000);

    const f = makeAbortCause({
      kind: "llmFailure",
      reason: "rateLimit",
      detail: "429 too many requests",
      retryAfterMs: 12000,
    });
    const rc = readCause(f) as { reason: string; detail: string; retryAfterMs?: number };
    expect(rc.kind ?? readCause(f)?.kind).toBe("llmFailure");
    expect(rc.reason).toBe("rateLimit");
    expect(rc.detail).toBe("429 too many requests");
    expect(rc.retryAfterMs).toBe(12000);

    // Carried on an AgencyAbort, both are still abort errors.
    expect(isAbortError(new AgencyAbort("m", f))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/errors.test.ts` → FAIL (TS: the two `kind`s are not assignable to `AbortCause`).

- [ ] **Step 3: Implement** — in `lib/runtime/errors.ts`, extend the `AbortCause` union (after the `cleanup` member):

```ts
  | { kind: "raceLoser" }
  | { kind: "cleanup" }
  // An abort WE initiate when a single llm() call exceeds its per-call deadline.
  | { kind: "callTimeout"; limitMs: number }
  // A provider/transport failure we observed (and, after exhausting retries,
  // surface). `detail` is the raw provider message; `retryAfterMs` is present
  // only when a value could be parsed from it (smoltalk does not expose headers).
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

## Task 2: Error classification helper (`llmRetry.ts`)

**Files:**
- Create: `lib/runtime/llmRetry.ts`
- Test: `lib/runtime/llmRetry.test.ts`

**Interfaces:**
- Consumes: `isAbortError`, `readCause` from `./errors.js`; the smoltalk error classes from `smoltalk`.
- Produces:
  - `type LLMRetryReason = "timeout" | "connectionLost" | "streamInterrupted" | "rateLimit" | "serverError" | "overloaded"`
  - `classifyLlmError(err: unknown): { reason: Exclude<LLMRetryReason, "timeout">; detail: string; retryAfterMs?: number } | null` — returns the classification when `err` is a **retryable provider/transport error**, or `null` when it is NOT retryable (terminal error, or — critically — an abort/cancel the loop must re-throw).

- [ ] **Step 1: Write the failing test** — `lib/runtime/llmRetry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyLlmError } from "./llmRetry.js";
import { AgencyAbort, makeAbortCause } from "./errors.js";
import { SmolContentPolicyError } from "smoltalk";

describe("classifyLlmError", () => {
  it("classifies transport drops as connectionLost", () => {
    for (const m of ["ECONNRESET", "fetch failed", "socket hang up", "network connection was lost"]) {
      expect(classifyLlmError(new Error(m))?.reason).toBe("connectionLost");
    }
  });
  it("classifies mid-stream drops as streamInterrupted", () => {
    expect(classifyLlmError(new Error("terminated: stream ended prematurely"))?.reason).toBe("streamInterrupted");
  });
  it("classifies rate limit and server errors", () => {
    expect(classifyLlmError(new Error("429 rate limit exceeded"))?.reason).toBe("rateLimit");
    expect(classifyLlmError(new Error("503 service unavailable"))?.reason).toBe("serverError");
    expect(classifyLlmError(new Error("overloaded_error: 529"))?.reason).toBe("overloaded");
  });
  it("carries the raw message as detail", () => {
    expect(classifyLlmError(new Error("ECONNRESET"))?.detail).toBe("ECONNRESET");
  });
  it("returns null for terminal errors (not retryable)", () => {
    expect(classifyLlmError(new Error("400 invalid request"))).toBeNull();
    expect(classifyLlmError(new SmolContentPolicyError("blocked"))).toBeNull();
  });
  it("returns null for aborts/cancels — the loop must re-throw, never retry", () => {
    expect(classifyLlmError(new AgencyAbort("c", makeAbortCause({ kind: "userInterrupt" })))).toBeNull();
    expect(classifyLlmError(new AgencyAbort("g", makeAbortCause({
      kind: "guardTrip", dimension: "time", limit: 1, spent: 2, guardId: "g1" })))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/runtime/llmRetry.ts`:

```ts
import { isAbortError } from "./errors.js";
import { SmolContentPolicyError, SmolContextWindowExceededError, SmolStructuredOutputError } from "smoltalk";

export type LLMRetryReason =
  | "timeout"
  | "connectionLost"
  | "streamInterrupted"
  | "rateLimit"
  | "serverError"
  | "overloaded";

/** Provider/transport reasons (everything except our own "timeout"). */
type ProviderReason = Exclude<LLMRetryReason, "timeout">;

// Ordered most-specific-first. smoltalk exposes only `message`, so we match on
// it (Pi's approach). Each entry maps a lowercased substring to a reason.
const PATTERNS: Array<[string, ProviderReason]> = [
  // mid-stream drops (check before the generic connection set)
  ["terminated", "streamInterrupted"],
  ["premature", "streamInterrupted"],
  ["stream ended", "streamInterrupted"],
  ["http/2", "streamInterrupted"],
  // rate limit
  ["429", "rateLimit"],
  ["rate limit", "rateLimit"],
  ["too many requests", "rateLimit"],
  // overloaded (best-effort; collapses to serverError if not present)
  ["overloaded", "overloaded"],
  ["529", "overloaded"],
  // server errors
  ["500", "serverError"],
  ["502", "serverError"],
  ["503", "serverError"],
  ["504", "serverError"],
  ["service unavailable", "serverError"],
  ["internal server error", "serverError"],
  // transport / connection
  ["econnreset", "connectionLost"],
  ["econnrefused", "connectionLost"],
  ["etimedout", "connectionLost"],
  ["enotfound", "connectionLost"],
  ["socket hang up", "connectionLost"],
  ["network connection was lost", "connectionLost"],
  ["network request failed", "connectionLost"],
  ["fetch failed", "connectionLost"],
  ["failed to fetch", "connectionLost"],
  ["load failed", "connectionLost"],
];

/**
 * Decide whether `err` is a retryable provider/transport failure.
 * Returns the classification, or `null` when NOT retryable — which covers BOTH
 * terminal provider errors AND aborts/cancels (the loop re-throws those; it
 * must never retry a user cancel or a guard trip).
 */
export function classifyLlmError(
  err: unknown,
): { reason: ProviderReason; detail: string; retryAfterMs?: number } | null {
  // NEVER retry an abort/cancel — propagate-never-swallow.
  if (isAbortError(err)) return null;
  // Terminal provider errors (typed by smoltalk) — do not retry.
  if (
    err instanceof SmolContentPolicyError ||
    err instanceof SmolContextWindowExceededError ||
    err instanceof SmolStructuredOutputError
  ) {
    return null;
  }
  const detail = err instanceof Error ? err.message : String(err);
  const hay = detail.toLowerCase();
  for (const [needle, reason] of PATTERNS) {
    if (hay.includes(needle)) {
      const retryAfterMs = parseRetryAfter(hay);
      return retryAfterMs !== undefined ? { reason, detail, retryAfterMs } : { reason, detail };
    }
  }
  // 4xx (other than 429) and anything unrecognized: treat as terminal.
  return null;
}

/** Best-effort parse of a "retry-after: Ns" / "retry after N seconds" hint from
 *  the message. Usually absent (smoltalk drops headers); returns ms or undefined. */
function parseRetryAfter(hay: string): number | undefined {
  const m = hay.match(/retry[- ]after[:\s]+(\d+)/);
  if (!m) return undefined;
  return Number(m[1]) * 1000;
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts && git commit -m "feat(runtime): message-pattern LLM error classifier"`

---

## Task 3: Add the `onLLMRetry` + `onLLMTimeout` hooks

**Files:**
- Modify: `lib/runtime/hooks.ts` (the `CallbackMap` type, ~line 25)
- Modify: `lib/types/function.ts` (`VALID_CALLBACK_NAMES`, ~line 25)
- Test: `lib/typechecker/callbackBodyInterrupts.test.ts` (extend) or a new `tests/agency-js/llm-retry-hook/` (covered in Task 7); a minimal unit assertion here.

**Interfaces:**
- Consumes: `LLMRetryReason` from `./llmRetry.js`.
- Produces: two callback names usable from agency (`callback("onLLMRetry") { ... }`) and fired via `callHook`. Payloads:
  - `onLLMRetry: { attempt: number; maxAttempts: number; delayMs: number; reason: LLMRetryReason; detail: string }`
  - `onLLMTimeout: { limitMs: number; attempt: number }`

- [ ] **Step 1: Write the failing test** — extend `lib/typechecker/callbackBodyInterrupts.test.ts` (it already imports the parse/typecheck harness) with a positive test that the new names are accepted:

```ts
it("accepts onLLMRetry / onLLMTimeout as valid callback names", () => {
  const errors = typecheckSource(`
    node main() {
      callback("onLLMRetry") as data { print("retry ${data.attempt}/${data.maxAttempts}") }
      callback("onLLMTimeout") as data { print("timeout ${data.limitMs}") }
      return "ok"
    }
  `);
  // No "unknown callback name" error.
  expect(errors.filter((e) => /callback name/i.test(e.message))).toEqual([]);
});
```

(Model `typecheckSource` on the existing helper in that test file.)

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/typechecker/callbackBodyInterrupts.test.ts` → FAIL (unknown callback name).

- [ ] **Step 3a: Add the names** — in `lib/types/function.ts`, add to `VALID_CALLBACK_NAMES` (before the closing `] as const`):

```ts
  "onThreadStart",
  "onThreadEnd",
  "onLLMRetry",
  "onLLMTimeout",
] as const;
```

- [ ] **Step 3b: Add the payloads** — in `lib/runtime/hooks.ts`, import the reason type at the top:

```ts
import type { LLMRetryReason } from "./llmRetry.js";
```

and add to the `CallbackMap` type (next to `onLLMCallEnd`):

```ts
  onLLMRetry: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: LLMRetryReason;
    detail: string;
  };
  onLLMTimeout: { limitMs: number; attempt: number };
```

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/typechecker/callbackBodyInterrupts.test.ts` → PASS. Then `npx tsc --noEmit` → 0 errors (the `CallbackMap` change typechecks).

- [ ] **Step 5: Commit** — `git add lib/runtime/hooks.ts lib/types/function.ts lib/typechecker/callbackBodyInterrupts.test.ts && git commit -m "feat(hooks): add onLLMRetry + onLLMTimeout callbacks"`

---

## Task 4: Per-call timeout (call-scoped abort)

**Files:**
- Modify: `lib/runtime/prompt.ts` (a small helper, used by Task 5)
- Test: `lib/runtime/prompt.test.ts` (export the helper via the existing `_internal` seam)

**Interfaces:**
- Consumes: `makeAbortCause` from `./errors.js`.
- Produces: `armCallTimeout(parentSignal: AbortSignal | undefined, limitMs: number): { signal: AbortSignal; dispose: () => void }` — composes a fresh timeout controller with `parentSignal`; the returned `signal` aborts (carrying a `callTimeout` cause) when `limitMs` elapses; `dispose()` clears the timer. When `limitMs <= 0`, returns `{ signal: parentSignal, dispose: () => {} }` (no deadline).

- [ ] **Step 1: Write the failing test** — in `lib/runtime/prompt.test.ts` add (using fake timers):

```ts
import { vi } from "vitest";
import { readCause } from "./errors.js";
// markThreadCancelled etc. already destructured from _internal; add armCallTimeout.

describe("armCallTimeout", () => {
  it("aborts with a callTimeout cause after limitMs", () => {
    vi.useFakeTimers();
    const { signal, dispose } = _internal.armCallTimeout(undefined, 1000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(signal.aborted).toBe(true);
    expect(readCause(signal)?.kind).toBe("callTimeout");
    expect((readCause(signal) as { limitMs: number }).limitMs).toBe(1000);
    dispose();
    vi.useRealTimers();
  });
  it("limitMs <= 0 passes the parent signal through with no timer", () => {
    const parent = new AbortController().signal;
    const { signal } = _internal.armCallTimeout(parent, 0);
    expect(signal).toBe(parent);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/prompt.test.ts` → FAIL (`armCallTimeout` undefined).

- [ ] **Step 3: Implement** — in `lib/runtime/prompt.ts` add the helper (near `markThreadCancelled`) and export it on `_internal`:

```ts
function armCallTimeout(
  parentSignal: AbortSignal | undefined,
  limitMs: number,
): { signal: AbortSignal; dispose: () => void } {
  if (limitMs <= 0) return { signal: parentSignal as AbortSignal, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new AgencyCancelledError(
        `llm call exceeded ${limitMs}ms`,
        makeAbortCause({ kind: "callTimeout", limitMs }),
      ),
    );
  }, limitMs);
  // Compose with the parent (guard / Esc) signal so either source aborts the call.
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}
```

Add `makeAbortCause` to the existing `./errors.js` import, and `armCallTimeout` to the `_internal` object.

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/prompt.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add lib/runtime/prompt.ts lib/runtime/prompt.test.ts && git commit -m "feat(prompt): call-scoped timeout (armCallTimeout)"`

---

## Task 5: The retry loop in `prompt.ts`

**Files:**
- Modify: `lib/runtime/prompt.ts` — wrap the `dispatchLLMRequest` call (~line 229) in the retry loop; thread a `retryPolicy` through `runPrompt`'s args.
- Test: `lib/runtime/prompt.test.ts` (unit, with a stub dispatch) — see Task 7 for the end-to-end agency-js test.

**Interfaces:**
- Consumes: `classifyLlmError`, `LLMRetryReason` (Task 2); `armCallTimeout` (Task 4); `callHook` (hooks.ts); `abortableSleep` from `../stdlib/abortable.js`; `makeAbortCause`, `AgencyCancelledError` from `./errors.js`.
- Produces: a `RetryPolicy = { retries: number; timeout: number; backoff: { initial: number; factor: number; max: number } }` field on `runPrompt`'s args, consumed here and supplied by Task 6.

- [ ] **Step 1: Write the failing test** — in `lib/runtime/prompt.test.ts`, add a unit test of the loop via a small exported `runWithRetry(dispatch, policy, signal, hooks)` seam (extract the loop as a pure-ish helper so it is unit-testable without a live provider). Assert: a dispatch that throws `Error("ECONNRESET")` twice then returns succeeds after 2 retries; `onLLMRetry` fired twice with `reason: "connectionLost"` and increasing `delayMs`; a dispatch that always throws surfaces an `AgencyAbort` whose cause is `llmFailure` after exactly `policy.retries` attempts; an Esc abort (`userInterrupt`) during the backoff re-throws and does not retry.

```ts
describe("runWithRetry", () => {
  const policy = { retries: 2, timeout: 0, backoff: { initial: 1, factor: 2, max: 10 } };
  it("retries a transient error then succeeds", async () => {
    let n = 0;
    const fired: any[] = [];
    const dispatch = async () => { if (n++ < 2) throw new Error("ECONNRESET"); return "ok"; };
    const res = await _internal.runWithRetry(dispatch, policy, undefined, {
      onRetry: (d: any) => fired.push(d), onTimeout: () => {},
    });
    expect(res).toBe("ok");
    expect(fired.map((f) => f.reason)).toEqual(["connectionLost", "connectionLost"]);
    expect(fired[1].delayMs).toBeGreaterThan(fired[0].delayMs);
  });
  it("surfaces an llmFailure after exhausting retries", async () => {
    const dispatch = async () => { throw new Error("503 service unavailable"); };
    await expect(
      _internal.runWithRetry(dispatch, policy, undefined, { onRetry: () => {}, onTimeout: () => {} }),
    ).rejects.toMatchObject({ agencyCause: { kind: "llmFailure", reason: "serverError" } });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/prompt.test.ts` → FAIL (`runWithRetry` undefined).

- [ ] **Step 3: Implement the helper** — in `lib/runtime/prompt.ts`:

```ts
import { abortableSleep } from "../stdlib/abortable.js";
import { classifyLlmError } from "./llmRetry.js";
import type { LLMRetryReason } from "./llmRetry.js";

type RetryPolicy = {
  retries: number;
  timeout: number;
  backoff: { initial: number; factor: number; max: number };
};

type RetryHooks = {
  onRetry: (d: { attempt: number; maxAttempts: number; delayMs: number; reason: LLMRetryReason; detail: string }) => void | Promise<void>;
  onTimeout: (d: { limitMs: number; attempt: number }) => void | Promise<void>;
};

/** Run `dispatch(signal)` under the policy. `dispatch` receives the per-attempt
 *  signal (parent composed with the per-call timeout). Returns the dispatch
 *  result, or throws the classified failure / re-throws an abort. */
async function runWithRetry<T>(
  dispatch: (signal: AbortSignal | undefined) => Promise<T>,
  policy: RetryPolicy,
  parentSignal: AbortSignal | undefined,
  hooks: RetryHooks,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const { signal, dispose } = armCallTimeout(parentSignal, policy.timeout);
    try {
      return await dispatch(signal);
    } catch (err) {
      dispose();
      // A timeout WE imposed: notify, then fall through to retry logic.
      const cause = readCause(err);
      if (cause?.kind === "callTimeout") {
        await hooks.onTimeout({ limitMs: cause.limitMs, attempt });
      }
      // classifyLlmError returns null for aborts/cancels AND terminal errors.
      const cls = classifyLlmError(err);
      const reason: LLMRetryReason | undefined =
        cause?.kind === "callTimeout" ? "timeout" : cls?.reason;
      // Not retryable (abort, cancel, terminal) OR out of attempts → surface.
      if (reason === undefined || attempt >= policy.retries) {
        if (cause?.kind === "callTimeout") throw err; // keep the callTimeout cause
        if (cls) {
          throw new AgencyCancelledError(cls.detail, makeAbortCause({
            kind: "llmFailure", reason: cls.reason, detail: cls.detail, retryAfterMs: cls.retryAfterMs,
          }));
        }
        throw err; // abort/cancel/terminal — propagate untouched
      }
      const delayMs = Math.min(
        cls?.retryAfterMs ?? policy.backoff.initial * Math.pow(policy.backoff.factor, attempt),
        policy.backoff.max,
      );
      await hooks.onRetry({ attempt: attempt + 1, maxAttempts: policy.retries, delayMs, reason, detail: cls?.detail ?? "timeout" });
      await abortableSleep(delayMs, parentSignal); // Esc during the wait throws → aborts the loop
    } finally {
      dispose();
    }
  }
}
```

Export `runWithRetry` on `_internal`.

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/prompt.test.ts` → PASS.

- [ ] **Step 5: Wire it into `runPrompt`** — add `retryPolicy: RetryPolicy` to `runPrompt`'s args type, and wrap the existing dispatch. Replace the current:

```ts
  try {
    ({ completion, toolCalls } = await dispatchLLMRequest({ ctx, promptConfig, prompt, stream, ... }));
```

with a `runWithRetry` call whose `dispatch(signal)` rebuilds `promptConfig` with `abortSignal: signal` and calls `dispatchLLMRequest`, and whose hooks call `callHook({ ctx, name: "onLLMRetry", data })` / `"onLLMTimeout"`. Keep the existing outer `catch` (dispatch normalization) — `runWithRetry` re-throws aborts and surfaces `llmFailure`, both of which the existing catch already handles correctly (an `llmFailure` is an `AgencyAbort` and will be re-thrown by the abort rung; the function/node catch ladder converts it to a Failure exactly as today).

- [ ] **Step 6: Build + targeted run** — `make`; re-run `pnpm test:run lib/runtime/prompt.test.ts lib/runtime/llmRetry.test.ts`. Save output to `/tmp/task5.log`.

- [ ] **Step 7: Commit** — `git add lib/runtime/prompt.ts && git commit -m "feat(prompt): retry loop with backoff + per-call timeout + hooks"`

---

## Task 6: `LlmOpts` knobs + `agency.json` defaults + plumbing

**Files:**
- Modify: `lib/runtime/agencyLlm.ts` (`LlmOpts`, the `runPrompt` call)
- Modify: `lib/config.ts` (`AgencyConfig`, ~line 28 — add an `llm` defaults block)
- Modify: `lib/runtime/llmRetry.ts` (add `resolveRetryPolicy`)
- Test: `lib/runtime/llmRetry.test.ts` (resolveRetryPolicy), `lib/runtime/agencyLlm` plumbing if a test exists

**Interfaces:**
- Produces: `resolveRetryPolicy(opts, config): RetryPolicy` applying precedence per-call → `agency.json` → built-in default; `LlmOpts` gains `retries?: number`, `timeout?: number`, `backoff?: { initial?: number; factor?: number; max?: number }`.

- [ ] **Step 1: Write the failing test** — in `lib/runtime/llmRetry.test.ts`:

```ts
import { resolveRetryPolicy } from "./llmRetry.js";
describe("resolveRetryPolicy", () => {
  it("uses built-in defaults when nothing is set", () => {
    expect(resolveRetryPolicy({}, {})).toEqual({
      retries: 2, timeout: 600000, backoff: { initial: 500, factor: 2, max: 10000 },
    });
  });
  it("per-call options override agency.json which overrides defaults", () => {
    const cfg = { llm: { retries: 5, timeout: 1000 } };
    expect(resolveRetryPolicy({ retries: 1 }, cfg as any)).toMatchObject({ retries: 1, timeout: 1000 });
  });
  it("retries:0 disables retry; timeout:0 disables the deadline", () => {
    const p = resolveRetryPolicy({ retries: 0, timeout: 0 }, {});
    expect(p.retries).toBe(0);
    expect(p.timeout).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/llmRetry.test.ts` → FAIL.

- [ ] **Step 3: Implement `resolveRetryPolicy`** in `lib/runtime/llmRetry.ts`:

```ts
export type RetryPolicy = {
  retries: number;
  timeout: number;
  backoff: { initial: number; factor: number; max: number };
};

const DEFAULTS: RetryPolicy = {
  retries: 2,
  timeout: 600000, // 10 min
  backoff: { initial: 500, factor: 2, max: 10000 },
};

export function resolveRetryPolicy(
  opts: { retries?: number; timeout?: number; backoff?: { initial?: number; factor?: number; max?: number } },
  config: { llm?: { retries?: number; timeout?: number; backoff?: { initial?: number; factor?: number; max?: number } } },
): RetryPolicy {
  const c = config.llm ?? {};
  const pick = <T>(...vals: (T | undefined)[]) => vals.find((v) => v !== undefined);
  return {
    retries: pick(opts.retries, c.retries, DEFAULTS.retries)!,
    timeout: pick(opts.timeout, c.timeout, DEFAULTS.timeout)!,
    backoff: {
      initial: pick(opts.backoff?.initial, c.backoff?.initial, DEFAULTS.backoff.initial)!,
      factor: pick(opts.backoff?.factor, c.backoff?.factor, DEFAULTS.backoff.factor)!,
      max: pick(opts.backoff?.max, c.backoff?.max, DEFAULTS.backoff.max)!,
    },
  };
}
```

Move the `RetryPolicy` type here (remove the local copy in prompt.ts; import it from `./llmRetry.js`).

- [ ] **Step 4: Run, verify pass** — `pnpm test:run lib/runtime/llmRetry.test.ts` → PASS.

- [ ] **Step 5: Add the knobs + plumb** — in `lib/runtime/agencyLlm.ts`, extend `LlmOpts`:

```ts
  /** Max retry attempts on a transient failure. Default 2; 0 disables. */
  retries?: number;
  /** Per-call deadline in ms. Default 600000 (10 min); 0 disables. */
  timeout?: number;
  /** Exponential backoff (ms). Defaults: initial 500, factor 2, max 10000. */
  backoff?: { initial?: number; factor?: number; max?: number };
```

and in `llm(...)`, resolve + pass the policy to `runPrompt`, reading the `llm` defaults off the runtime context (threaded in Step 5a below — there is NO `ctx.config`; config sub-blocks are passed into `RuntimeContext` like `memory` is):

```ts
  const { ctx } = getRuntimeContext();
  const retryPolicy = resolveRetryPolicy(opts, { llm: ctx.getLlmConfig() });
  return runPrompt({ prompt, messages: thread, responseFormat: opts.schema, clientConfig, retryPolicy, checkpointInfo: agencyStore.getStore()?.callsite });
```

- [ ] **Step 5a: Thread `llm` config into `RuntimeContext` — mirror `memory`.** AgencyConfig sub-blocks are NOT exposed as a single `ctx.config`; they're passed into the `RuntimeContext` constructor (`lib/runtime/state/context.ts:188`, e.g. `memory?: MemoryConfig`) and stored as a private field (`this.jsonMemoryConfig = args.memory`, context.ts:259). Follow that exact pattern for `llm`:
  - Add `llm?: LlmConfig` to the constructor args type (next to `memory?`), where `LlmConfig = { retries?: number; timeout?: number; backoff?: { initial?: number; factor?: number; max?: number } }`.
  - Store it: `this.jsonLlmConfig = args.llm;`
  - Expose a reader: `getLlmConfig(): LlmConfig { return this.jsonLlmConfig ?? {}; }`
  - At the construction site that builds the context from the loaded `AgencyConfig` (wherever `memory: config.memory` is passed — search `grep -rn "memory: .*config" lib/ --include=*.ts | grep -i runtimecontext` / the CLI run path), add `llm: config.llm`.

- [ ] **Step 6: Add the config block** — in `lib/config.ts` `AgencyConfig` (line 28), add:

```ts
  /** Default LLM resilience policy (per-call llm() options override these). */
  llm?: {
    retries?: number;
    timeout?: number;
    backoff?: { initial?: number; factor?: number; max?: number };
  };
```

- [ ] **Step 7: Build + typecheck** — `make`; `npx tsc --noEmit` → 0 errors.

- [ ] **Step 8: Commit** — `git add lib/runtime/agencyLlm.ts lib/runtime/llmRetry.ts lib/runtime/llmRetry.test.ts lib/config.ts lib/runtime/prompt.ts && git commit -m "feat(llm): retries/timeout/backoff options + agency.json defaults"`

---

## Task 7: End-to-end agency-js integration test

**Files:**
- Create: `tests/agency-js/llm-retry/agent.agency`, `tests/agency-js/llm-retry/test.js`, `tests/agency-js/llm-retry/fixture.json`, `tests/agency-js/llm-retry/agency.json`

**Interfaces:**
- Consumes: the `__setLLMClient` test seam (see `tests/agency-js/tool-call-no-phantom-thread/test.js` for the pattern) to inject a client that throws transient errors before succeeding.

- [ ] **Step 1: Write the agent** — `agent.agency` registers an `onLLMRetry` callback that records attempts, calls `llm()` with `{ retries: 3, backoff: { initial: 1ms, factor: 2, max: 5ms } }`, and returns a marker including the retry count:

```
node main() {
  let retries = 0
  callback("onLLMRetry") as data {
    retries = retries + 1
  }
  const answer = llm("ping", { retries: 3, backoff: { initial: 1ms, factor: 2, max: 5ms } })
  return "${answer}:retries=${retries}"
}
```

(Note: `retries` is a node-local mutated from a callback — confirm the callback can write a node local in this harness; if not, count via the statelog instead, mirroring `tool-call-no-phantom-thread`.)

- [ ] **Step 2: Write the driver** — `test.js` imports `{ main, __setLLMClient }`, sets a client whose `text()` throws `Error("ECONNRESET")` on the first 2 calls then returns `"pong"`, runs `main()`, writes `__result.json`. Set `useTestLLMProvider` marker / `agency.json` per the existing agency-js pattern.

- [ ] **Step 3: `fixture.json`** — expected `{ "data": "pong:retries=2" }`.

- [ ] **Step 4: Build + run** — `make`; `pnpm run a test js tests/agency-js/llm-retry`. Save output to `/tmp/task7.log`. Verify PASS.

- [ ] **Step 5: Add a timeout scenario** — a second test dir `tests/agency-js/llm-timeout/` whose client `text()` delays past a tiny `timeout: 20ms` (and `retries: 0`), with an `onLLMTimeout` callback; assert the call surfaces a failure and the timeout hook fired exactly once. (If the deterministic client can't delay, drive the timeout via a real `sleep` inside the mock; if neither is feasible, document the gap in the commit and rely on the `armCallTimeout` unit test from Task 4.)

- [ ] **Step 6: Commit** — `git add tests/agency-js/llm-retry tests/agency-js/llm-timeout && git commit -m "test(agency-js): end-to-end llm retry + timeout"`

---

## Task 8: Documentation

**Files:**
- Modify: `docs/site/guide/llm.md` (the new `llm()` options + behavior)
- Modify: `docs/site/appendix/callbacks.md` (the two new hooks in the hook list)

- [ ] **Step 1: Document the options** — in `llm.md`, add a "Resilience" section: the `retries` / `timeout` / `backoff` options with their defaults (retries 2, timeout 10min, backoff 500ms×2 cap 10s), `retries: 0` / `timeout: 0` to disable, the `agency.json` `llm` block, and the smoltalk-classification limitation (message-based; no precise `retry-after`).

- [ ] **Step 2: Document the hooks** — in `callbacks.md`, add `onLLMRetry` and `onLLMTimeout` to the hook list with their payloads, noting they are side-effect-only (cannot affect retry/flow — consistent with the existing callback rules).

- [ ] **Step 3: Commit** — `git add docs/site/guide/llm.md docs/site/appendix/callbacks.md && git commit -m "docs: llm resilience options + retry/timeout hooks"`

---

## Final verification

- [ ] `make` clean; `npx tsc --noEmit` → 0 errors.
- [ ] `pnpm test:run lib/runtime/errors.test.ts lib/runtime/llmRetry.test.ts lib/runtime/prompt.test.ts lib/typechecker/callbackBodyInterrupts.test.ts` → all green.
- [ ] `pnpm run a test js tests/agency-js/llm-retry` (+ the timeout dir) green; save output.
- [ ] `pnpm run lint:structure` clean.
- [ ] Spot-check the propagate-never-swallow invariant: a `guard(time:)` wrapping an `llm()` that errors transiently still trips the guard (the guard's `guardTrip` is returned by `classifyLlmError` as `null` → re-thrown, never retried).
- [ ] Open the PR; call out the smoltalk-classification limitation (message-based; precise `retry-after` + `529`/`500` disambiguation deferred to a smoltalk change).

## Notes for the implementer

- **smoltalk is external** (`node_modules/smoltalk`): do not try to extend it in this plan. Classification is message-based by design here; honoring server `retry-after` headers and reliably tagging `overloaded` are a separate follow-up that requires smoltalk to surface status/headers.
- **Streaming:** `dispatchLLMRequest` handles both stream and non-stream; the retry loop wraps it, so a mid-stream drop is caught and retried. Verify that a failed streaming attempt does NOT leave partial assistant text on the thread before the retry (if it does, the retry task must clear it — check how `dispatchLLMRequest` appends streamed content on error).
- **Cost:** a failed transport attempt should not charge; confirm the post-call accounting in `prompt.ts` runs only on the successful attempt (it is downstream of `dispatchLLMRequest` returning).
