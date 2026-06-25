import { describe, it, expect } from "vitest";
import {
  SmolError,
  SmolContentPolicyError,
  SmolContextWindowExceededError,
  SmolTimeoutError,
  SmolRateLimitError,
  SmolOverloadedError,
  SmolAuthError,
} from "smoltalk";
import { SmoltalkClient } from "./llmClient.js";

describe("SmoltalkClient.normalizeError", () => {
  const client = new SmoltalkClient();

  it("extracts status and retryAfterMs from an HTTP SmolError", () => {
    // smoltalk parses `retry-after` itself (`retryAfterMs` on the error);
    // we just read it through.
    const err = new SmolError("429 too many requests", {
      status: 429,
      retryAfterMs: 5000,
    });
    const n = client.normalizeError(err);
    expect(n.status).toBe(429);
    expect(n.retryAfterMs).toBe(5000);
    expect(n.kind).toBeUndefined();
    expect(n.message).toBe("429 too many requests");
  });

  it("maps typed terminal errors to a kind", () => {
    expect(client.normalizeError(new SmolContentPolicyError("blocked")).kind).toBe("contentPolicy");
    expect(client.normalizeError(new SmolContextWindowExceededError("too long")).kind).toBe("contextWindow");
    expect(client.normalizeError(new SmolTimeoutError("timed out")).kind).toBe("requestTimeout");
    expect(client.normalizeError(new SmolAuthError("bad key")).kind).toBe("auth");
  });

  it("maps typed retryable errors to a kind", () => {
    expect(client.normalizeError(new SmolRateLimitError("slow down")).kind).toBe("rateLimit");
    expect(client.normalizeError(new SmolOverloadedError("server busy")).kind).toBe("overloaded");
  });

  it("returns just the message for a non-smoltalk error", () => {
    const n = client.normalizeError(new Error("ECONNRESET"));
    expect(n).toEqual({ message: "ECONNRESET" });
  });
});
