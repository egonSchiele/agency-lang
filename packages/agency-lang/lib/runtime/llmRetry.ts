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
