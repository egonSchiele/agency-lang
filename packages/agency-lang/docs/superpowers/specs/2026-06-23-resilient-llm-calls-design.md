---
name: Resilient LLM calls — design
description: Backend retry + per-call timeout for llm(), a classified llmFailure/callTimeout cause with a shared 6-value reason vocabulary, and notification hooks (onLLMRetry / onLLMTimeout). Spec A of two; Spec B (unhandled-failure propagation) follows.
---

# Resilient LLM calls

## 1. Problem

LLM calls fail transiently far more often than the rest of an agent's code: the socket drops mid-stream, the provider returns a 429/503, or the request simply hangs with no bytes. Today an `llm()` call has **no retry and no deadline**:

- A transient provider error is rethrown unchanged from `prompt.ts`, propagates to the enclosing function's auto-catch, and becomes a generic *string* `Failure` — no retry, and the failure is indistinguishable from any other error.
- A silent hang (connection alive, no data) has no deadline at all, so it blocks until the provider/socket eventually gives up — or forever.

The result: authors must defensively `try`/check every `llm()` call for failures that are usually transient and self-healing, which is exactly the DX we want to avoid.

**This spec (A)** makes LLM calls *resilient*: classify transient failures, retry them with backoff, impose an optional per-call deadline, and notify the author of retries/timeouts — all in the backend, so the happy path is unchanged and existing code gets resilience for free.

**This spec does NOT** change what happens to a failure that survives all retries. After exhaustion the call throws a *classified* failure that behaves exactly as failures do today. Making that residual failure propagate sanely (instead of silently materializing as a mistyped value) is the **separate Spec B — unhandled-failure propagation**, brainstormed next.

## 2. Scope & non-goals

In scope:
- Per-`llm()` configuration: `retries`, `backoff`, `timeout`.
- Backend retry loop with exponential backoff, honoring server `retry-after`.
- A per-call timeout (a mini, call-scoped `TimeGuard`).
- A shared 6-value `reason` vocabulary, two `AbortCause` variants (`callTimeout` + a unified `llmFailure`), and a `detail` string for specifics.
- Two notification hooks: `onLLMRetry`, `onLLMTimeout`.

Non-goals (explicitly deferred):
- **Unhandled-failure propagation** (Spec B / the "Zig-style" model). Spec A surfaces the residual failure; Spec B decides how an unhandled failure travels.
- **Interactive "retry? y/n" prompt.** Neither Pi nor opencode does this; in agency a blocking prompt would require an `interrupt`, which is a node's job, not a callback's. We auto-retry and let Esc cancel.
- **Enclosing-scope-reading callbacks.** A separate, larger callback enhancement; not needed here (`onLLMRetry` gets everything it needs from the hook payload).
- **Retrying mid-stream partial output reassembly.** A dropped stream restarts the call (see §8 Risks).

## 3. Prior art (why this shape)

Pi (`agent-session.ts`) and opencode (`util/retry.ts`, `llm/route/executor.ts`) converge on the same pattern, and **neither prompts the user**:

- Classify the error (opencode: typed errors with a `retryable` getter; Pi: message-pattern matching) into transient vs terminal.
- **Automatic** exponential backoff retry at the agent/executor level (not delegated to the SDK — Pi sets SDK `maxRetries: 0` and owns the loop). Honor server `retry-after` when present, capped at a max delay.
- **Visible but non-blocking:** the UI shows `"Retrying (2/5) in 4s… (Esc to cancel)"`; the human's only decision is "let it keep going" (default) or cancel.
- Reset the attempt counter on the first success; surface the (typed) error only after attempts exhaust.

Agency already has the cancel half for free: the `userInterrupt` cause from Esc (shipped in the abort-taxonomy work) aborts a backoff wait with no new machinery.

## 4. Configuration surface

### 4.1 Per-`llm()` options

```
llm(prompt, {
  retries: 2,                                  // max retry attempts on a transient failure
  backoff: { initial: 500ms, factor: 2, max: 10s },   // exponential, capped
  timeout: 10min,                              // per-attempt deadline → abort + (maybe) retry
})
```

- Durations use **agency unit literals** (`500ms`, `10s`, `10min`), consistent with `guard(time: …)`.
- These thread through the existing `clientConfig` path into `prompt.ts` (`runPrompt`'s `clientConfig: Partial<smoltalk.SmolConfig>` argument) as a sibling options bag — the retry/timeout policy is consumed by the runtime loop, not forwarded to smoltalk as a model param.

### 4.2 Defaults (both default-ON)

| Option | Default | Disable |
| --- | --- | --- |
| `retries` | `2` | `retries: 0` |
| `backoff` | `{ initial: 500ms, factor: 2, max: 10s }` | n/a (only used when retrying) |
| `timeout` | `10min` | `timeout: 0` (= no deadline) |

- `retries` default-on is safe: it only ever fires on a *classified-transient* failure, so happy-path behavior is unchanged.
- `timeout` default-on at **10 min** is deliberately generous — large enough not to abort a legitimately slow reasoning call, small enough to rescue a true hang. `retries: 0` + `timeout` is a valid combination ("deadline but no retry"): the call aborts at the deadline, fires `onLLMTimeout`, and surfaces the failure without retrying.

### 4.3 Precedence

Per-call option → `agency.json` (`llm.retries`, `llm.timeout`, `llm.backoff`) → built-in default. This mirrors the existing runtime-config → per-`llm()`-option path.

### 4.4 Server `retry-after`

When the provider returns a `retry-after` / `retry-after-ms` (rate limits), it **overrides** the computed backoff for that attempt, capped at `backoff.max`. (Both reference agents do this.)

## 5. Classification — what is retryable

Performed in the backend boundary (`prompt.ts`), reading the provider error.

**Retry:**
- Connection/transport errors: `ECONNRESET`, `ETIMEDOUT`, `fetch failed`, `socket hang up`, "connection lost", premature stream end, terminated.
- Server errors: `5xx`, `503`, `529`.
- Rate limit: `429` (honor `retry-after`).
- Our own `callTimeout` (a deadline we imposed).

**Never retry (terminal):**
- `400` invalid request, `401`/`403` auth, content-policy / context-window errors (smoltalk already has typed `SmolContentPolicyError` / `SmolContextWindowExceededError`).

**Never retry, always propagate (not failures):**
- User/abort causes — `userInterrupt`, `userKill`, `guardTrip`, `raceLoser`, `cleanup`. A retry loop MUST re-throw these immediately; it must never swallow a cancel or a guard trip (the propagate-never-swallow contract from the abort-taxonomy work).

> **Implementation dependency (for the plan):** classification needs provider status/headers and a `retry-after`. smoltalk exposes a typed error hierarchy (`SmolError`, `SmolTimeoutError`, `SmolContentPolicyError`, `SmolContextWindowExceededError`) but it is unverified whether `SmolError` carries HTTP status + response headers. The plan must confirm and, if not, either extend smoltalk or fall back to message-pattern matching (Pi's approach) for the connection/transport set.

## 6. Classification, causes & reasons (one shared vocabulary)

A single `reason` vocabulary is used by **both** the `onLLMRetry` hook and the residual failure cause, so what the user is *told* during a retry and what they can *match on* after exhaustion line up exactly:

```ts
type LLMRetryReason =
  | "timeout"            // our per-call deadline fired (→ callTimeout cause)
  | "connectionLost"     // transport never delivered / dropped before the stream
  | "streamInterrupted"  // connection established + producing tokens, then died mid-stream
  | "rateLimit"          // 429 (honors retry-after)
  | "serverError"        // generic 5xx / 503
  | "overloaded"         // provider at capacity (e.g. Anthropic 529 / overloaded_error)
```

Add to the `AbortCause` union (`lib/runtime/errors.ts`):

```ts
| { kind: "callTimeout"; limitMs: number }      // an abort WE initiate at the deadline
| {
    kind: "llmFailure";
    reason: Exclude<LLMRetryReason, "timeout">;  // the 5 provider/transport reasons
    detail: string;                              // raw provider message, for display/logging
    retryAfterMs?: number;                       // present for rateLimit when the server sent it
  }
```

- **Why two causes, not one.** `callTimeout` is structurally an abort *we* initiate (a known `limitMs`, like `guardTrip`) — it is the cause on the per-call `AbortController` (§7.1). `llmFailure` classifies a provider/transport failure we *observed*. They share the `reason` vocabulary (`callTimeout` ≙ `reason: "timeout"`) so the hook enum and the residual failure stay aligned without forcing the timeout's `limitMs` into a grab-bag.
- **`detail` is the granularity win** (the opencode lesson): a tight `reason` *category* plus an unbounded `detail` string (`"ECONNRESET"`, `"anthropic 529 overloaded_error"`, `"stream ended after 412 tokens"`) — granularity for display/logging without an enum explosion.
- **Prune to what we can detect.** The 6 reasons are the *target*. The runtime only emits a reason it can reliably distinguish from the provider error; if classification can't tell a `529` from a `500` (the §11 smoltalk dependency), `overloaded` collapses into `serverError`, and a pre-stream vs mid-stream drop may both read as `connectionLost`. Spec writes the full set; the plan prunes to detectable.
- `readCause` / `isAbortError` already handle any branded cause; no carrier change beyond these two variants.

## 7. Mechanism (backend, per-execution)

All state lives on the per-run `StateStack` / per-run ALS frame — **no TS module globals** — preserving per-execution isolation (verified invariant).

### 7.1 Per-call timeout — a call-scoped mini-TimeGuard

For one `llm()` dispatch, when `timeout > 0`:
- Create a per-call `AbortController`; `setTimeout(timeout)` → `controller.abort(makeAbortCause({ kind: "callTimeout", limitMs }))`.
- Compose it into the call's signal alongside `ctx.getAbortSignal(stack)` (same `AbortSignal.any` composition `TimeGuard.installAbortPlumbing` uses), so the in-flight request aborts carrying the `callTimeout` cause.
- This is structurally identical to `TimeGuard` but scoped to a single call rather than a block, and it is **not** pushed onto `stack.guards` (it owns no guard scope) — it lives only for the duration of the dispatch.

### 7.2 Retry loop

Wraps the dispatch in `prompt.ts` (the single LLM-call boundary):

```
attempt = 0
loop:
  arm per-call timeout (§7.1)
  try dispatch
    on success: clear timeout; return            // happy path unchanged
  catch err:
    clear timeout
    if err is a user/abort cause (§5): re-throw   // never swallow
    if err is callTimeout: fire onLLMTimeout
    if not retryable OR attempt >= retries:
        throw classified failure (callTimeout, or llmFailure{ reason, detail, retryAfterMs? })
    delay = retry-after ?? min(backoff.initial * backoff.factor^attempt, backoff.max)
    fire onLLMRetry({ attempt+1, maxAttempts: retries, delayMs: delay, reason, detail })
    await cancellable sleep(delay)                // Esc → userInterrupt aborts the loop
    attempt++
```

- **Cancel for free:** the backoff `sleep` honors `stack.abortSignal`; an Esc (`userInterrupt`) during the wait aborts the loop and propagates as a normal cancel.
- **Counter reset:** the loop is per-call; a fresh `llm()` starts at `attempt = 0`.

### 7.3 Interaction with guards & cost

- A surrounding `guard(time: …)` keeps ticking *through* backoff waits — its timer can trip mid-retry, and the guard wins (its `guardTrip` is a user/abort cause that the loop re-throws immediately, §5). Correct and desirable.
- Cost: a failed transport attempt typically charges nothing; a successful (post-retry) call charges once via the normal post-call accounting. A cost `guard` therefore sees only real spend. (The plan should confirm no double-charge on the success-after-retry path.)

## 8. Notification hooks

Two new side-effect-only hooks in the callback system (`hooks.ts` + the typed hook list), fired by the retry loop. Per the callback rules they cannot raise interrupts or affect control flow — they *notify* only.

| Hook | Payload | Fires |
| --- | --- | --- |
| `onLLMRetry` | `{ attempt, maxAttempts, delayMs, reason: LLMRetryReason, detail: string }` — `reason` is the §6 vocabulary; `detail` is the raw provider message | Immediately before each backoff wait. |
| `onLLMTimeout` | `{ limitMs, attempt }` | Whenever a call hits its per-call deadline, **regardless of whether a retry follows**. |

- A timeout that then retries fires **both** (`onLLMTimeout`, then `onLLMRetry`). A `retries: 0` + `timeout` case fires only `onLLMTimeout`, then surfaces the failure.
- These give the TUI/agent the "Retrying (2/5) in 4s…" surface without the retry/disposition living in a callback.

## 9. Disposition after exhaustion

When all attempts are exhausted (or `retries: 0`), the loop throws a `callTimeout`- or `llmFailure{reason, detail}`-caused failure. From there it behaves **exactly as failures do today**: it propagates to the enclosing function's auto-catch and becomes that function's `Failure`. Spec B changes how that residual unhandled failure travels; Spec A intentionally does not.

## 10. Testing strategy

Deterministic, no live LLM (per CLAUDE.md — do not run the full agency suite locally; run targeted tests while iterating, save output to a file):

- **Retry-then-succeed:** a mock client that throws a transient error N<retries times then succeeds → assert the call returns the success, the loop retried N times, and `onLLMRetry` fired N times with increasing `delayMs`.
- **Exhaustion:** transient error every time → assert it surfaces an `llmFailure` failure carrying the right `reason`/`detail` after exactly `retries` attempts.
- **Reason classification:** a `529`/overloaded, a mid-stream drop, a `429` (with `retry-after`), and a `503` each map to `overloaded` / `streamInterrupted` / `rateLimit` (with `retryAfterMs`) / `serverError` respectively — pruned to whatever the smoltalk error surface actually distinguishes (§11).
- **Timeout + retry:** a mock client that delays past `timeout` → assert the call aborts with `callTimeout`, `onLLMTimeout` fires, then `onLLMRetry`, then a subsequent attempt.
- **Timeout, no retry (`retries: 0`):** assert `onLLMTimeout` fires once and the failure surfaces without a retry.
- **Terminal error not retried:** a `400`/auth/content-policy error → assert no retry, surfaces immediately.
- **Never swallow:** an Esc (`userInterrupt`) during a backoff wait → assert the loop aborts and the cancel propagates (not converted to a Failure); a `guard(time:)` that trips during backoff → assert the `guardTrip` surfaces as the guard's `timeoutFailure`, not retried.
- **Classification matrix:** each retryable vs terminal error string/status maps to the right decision.
- **Cause round-trip:** `readCause` over `callTimeout{limitMs}` and `llmFailure{reason, detail, retryAfterMs?}` via both `signal.reason` and a thrown `AgencyAbort`.
- **Isolation:** the retry loop holds no TS module state (assert via the existing per-execution patterns; two concurrent runs retrying independently don't interfere).

## 11. Open questions / risks

1. **smoltalk error surface** (§5 dependency): does `SmolError` expose HTTP status + headers (for `429`/`5xx` + `retry-after`)? If not, the plan extends smoltalk or falls back to message matching for the transport set. Highest-risk unknown.
2. **Streaming:** a drop mid-stream means partial tokens were already yielded. V1 restarts the whole call on retry (no partial reassembly); the plan should confirm the streaming path can be cleanly aborted + restarted and that no partial output leaks to the thread.
3. **Default `timeout: 10min`** changes behavior for any call that legitimately runs longer than 10 min — believed rare, but a knob to set `timeout: 0` (no deadline) must exist and be documented.
4. **Cost double-charge** on success-after-retry (§7.3) — confirm the post-call accounting runs once.
5. **`agency.json` schema:** the `llm.{retries,backoff,timeout}` config block needs a home in the AgencyConfig type (exact location TBD by the plan).

## 12. Relationship to Spec B

Spec A reduces how *often* an LLM call fails and *classifies* the residual failure. Spec B (unhandled-failure propagation) decides how an unhandled failure — from `llm()` or any call — travels: propagate-by-default up the call chain instead of silently materializing as a mistyped value. A is shippable and useful alone; B is the larger language-semantics change that retires the "check every call" tax. They share the `AbortCause` taxonomy and the `Result` model but are independent PRs.
