import { describe, it, expect } from "vitest";
import { formatError } from "../../src/internal/errors.js";

describe("formatError", () => {
  it("uses HTTP status + GitHub API message for Octokit-shaped errors", () => {
    const e = { status: 404, response: { data: { message: "Not Found" } }, message: "ignored" };
    expect(formatError(e)).toBe("HTTP 404: Not Found");
  });

  it("uses HTTP status alone if no API message present", () => {
    expect(formatError({ status: 500 })).toBe("HTTP 500");
  });

  it("falls back to .message for non-HTTP errors", () => {
    expect(formatError(new Error("ENOTFOUND"))).toBe("ENOTFOUND");
  });

  it("returns 'unknown error' for objects with no useful info", () => {
    expect(formatError({})).toBe("unknown error");
  });

  it("stringifies primitives", () => {
    expect(formatError("nope")).toBe("nope");
    expect(formatError(null)).toBe("null");
    expect(formatError(42)).toBe("42");
  });

  // ─── credential scrubbing ───────────────────────────────────────────────

  it("redacts ghp_ tokens that appear in error messages", () => {
    const msg = "request failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(formatError(new Error(msg))).not.toContain("ghp_abcdef");
    expect(formatError(new Error(msg))).toContain("[REDACTED]");
  });

  it("redacts github_pat_ tokens", () => {
    const msg = "tried github_pat_AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555 to authenticate";
    expect(formatError(new Error(msg))).not.toContain("github_pat_AAAA");
    expect(formatError(new Error(msg))).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const msg = "header Authorization: Bearer secret-token-value";
    expect(formatError(new Error(msg))).not.toContain("secret-token-value");
  });

  it("redacts credentials inside API response messages too", () => {
    const e = { status: 401, response: { data: { message: "bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here" } } };
    const out = formatError(e);
    expect(out).toContain("HTTP 401");
    expect(out).not.toContain("ghp_abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("does not over-redact plain text that mentions 'token' without a value", () => {
    expect(formatError(new Error("missing token"))).toBe("missing token");
  });
});
