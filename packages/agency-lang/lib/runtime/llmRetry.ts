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

  // 3. Typed provider classifications the client recognized — preferred over
  // status sniffing so a custom client can signal these directly. Order
  // matters: terminal kinds short-circuit; retryable kinds reuse retryAfterMs
  // when present (e.g. for rateLimit).
  if (normalized.kind !== undefined) {
    switch (normalized.kind) {
      case "contentPolicy":
      case "contextWindow":
      case "structuredOutput":
      case "auth":
        return { kind: "terminal", detail: normalized.message };
      case "requestTimeout":
        // The provider SDK's own request timeout — the request didn't
        // complete; treat like a transport drop.
        return { kind: "retryable", reason: "connectionLost", detail: normalized.message };
      case "rateLimit":
        return {
          kind: "retryable",
          reason: "rateLimit",
          detail: normalized.message,
          ...(normalized.retryAfterMs !== undefined && { retryAfterMs: normalized.retryAfterMs }),
        };
      case "overloaded":
        return { kind: "retryable", reason: "overloaded", detail: normalized.message };
    }
  }

  // 4. HTTP errors — classify by status (covers clients that supply `status`
  // but not `kind`).
  if (normalized.status !== undefined) {
    return classifyByStatus(normalized);
  }

  // 5. No status: a transport drop. Message-match.
  return classifyByMessage(normalized.message);
}

function classifyByStatus(normalized: NormalizedLLMError): Classification {
  const status = normalized.status as number;
  if (status === 429) {
    if (normalized.retryAfterMs !== undefined) {
      return {
        kind: "retryable",
        reason: "rateLimit",
        detail: normalized.message,
        retryAfterMs: normalized.retryAfterMs,
      };
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

export type RetryPolicy = {
  retries: number;
  timeout: number;
  backoff: { initial: number; factor: number; max: number };
};

/** Built-in policy: 2 retries, a 10-minute per-call deadline, exponential
 *  backoff (500ms × 2, capped at 10s). Per-call llm() options and
 *  setLlmOptions / agency.json defaults override these (see resolveRetryPolicy). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 2,
  timeout: 600000,
  backoff: { initial: 500, factor: 2, max: 10000 },
};

export type RetryDecision =
  | { kind: "propagate" } // user/abort cause — re-throw err untouched (propagates as a cancel)
  | { kind: "terminal" } // terminal provider error — re-throw err (catch ladder converts to a Failure)
  | { kind: "surfaceFailure"; reason: LLMRetryReason; detail: string; retryAfterMs?: number } // exhausted — surface a Failure
  | { kind: "retry"; delayMs: number; reason: LLMRetryReason; detail: string };

/**
 * Decide what to do with a caught LLM-call error on the given attempt. Pure —
 * no I/O, no hooks, no timers — so the whole policy table is testable in
 * isolation and the loop stays a thin driver.
 */
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

  // c.kind === "retryable". Out of attempts → surface the residual as a Failure
  // (a plain throw the catch ladder converts — NOT an abort that aborts the run).
  if (attempt >= policy.retries) {
    return { kind: "surfaceFailure", reason: c.reason, detail: c.detail, retryAfterMs: c.retryAfterMs };
  }

  return { kind: "retry", delayMs: backoffMs(c.retryAfterMs, attempt, policy), reason: c.reason, detail: c.detail };
}

function backoffMs(retryAfterMs: number | undefined, attempt: number, policy: RetryPolicy): number {
  let base: number;
  if (retryAfterMs !== undefined) {
    base = retryAfterMs;
  } else {
    base = policy.backoff.initial * Math.pow(policy.backoff.factor, attempt);
  }
  return Math.min(base, policy.backoff.max);
}

export type RetryConfig = {
  retries?: number;
  timeout?: number;
  backoff?: { initial?: number; factor?: number; max?: number };
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

/**
 * Resolve the effective policy for one call. Precedence: per-call `opts`
 * (from `llm(prompt, {...})`) → `branchDefaults` (`stack.other.llmDefaults`,
 * set per-branch by `setLlmOptions`) → DEFAULT_RETRY_POLICY. (An agency.json
 * `llm` defaults block is a future follow-up — it needs the generated
 * RuntimeContext construction to seed the bag.)
 */
export function resolveRetryPolicy(opts: RetryConfig, branchDefaults: RetryConfig): RetryPolicy {
  return {
    retries: firstDefined(opts.retries, branchDefaults.retries, DEFAULT_RETRY_POLICY.retries),
    timeout: firstDefined(opts.timeout, branchDefaults.timeout, DEFAULT_RETRY_POLICY.timeout),
    backoff: {
      initial: firstDefined(
        opts.backoff?.initial,
        branchDefaults.backoff?.initial,
        DEFAULT_RETRY_POLICY.backoff.initial,
      ),
      factor: firstDefined(
        opts.backoff?.factor,
        branchDefaults.backoff?.factor,
        DEFAULT_RETRY_POLICY.backoff.factor,
      ),
      max: firstDefined(opts.backoff?.max, branchDefaults.backoff?.max, DEFAULT_RETRY_POLICY.backoff.max),
    },
  };
}
