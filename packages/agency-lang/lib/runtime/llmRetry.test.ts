import { describe, it, expect } from "vitest";
import { classifyLlmError, decideRetry, enrichSchemaLimitationError, resolveRetryPolicy } from "./llmRetry.js";
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
    expect(
      classifyLlmError(new Error("terminated before response"), { message: "terminated before response" }),
    ).toMatchObject({
      kind: "retryable",
      reason: "streamInterrupted",
    });
  });
});

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

describe("enrichSchemaLimitationError (#487)", () => {
  it("enriches the Anthropic circular-reference 400 with actionable guidance", () => {
    // Exact message shape from a live probe (2026-07-09):
    const err = new Error(
      'invalid_request_error: output_format.schema: Circular reference detected in schema definitions: __schema0 -> __schema0. Self-referencing or mutually-referencing definitions are not supported.',
    );
    const enriched = enrichSchemaLimitationError(err);
    expect(enriched).not.toBeNull();
    expect(enriched!.message).toMatch(/recursive type/i);
    expect(enriched!.message).toMatch(/parseJSON/);
    // Original provider text preserved for debugging.
    expect(enriched!.message).toContain("Circular reference detected");
  });

  it("returns null for unrelated errors", () => {
    expect(enrichSchemaLimitationError(new Error("rate limited"))).toBeNull();
    expect(enrichSchemaLimitationError("not an error")).toBeNull();
  });
});
