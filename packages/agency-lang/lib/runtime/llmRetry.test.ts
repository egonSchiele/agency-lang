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
    expect(
      classifyLlmError(new Error("terminated before response"), { message: "terminated before response" }),
    ).toMatchObject({
      kind: "retryable",
      reason: "streamInterrupted",
    });
  });
});
