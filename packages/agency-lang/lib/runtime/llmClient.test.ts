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
