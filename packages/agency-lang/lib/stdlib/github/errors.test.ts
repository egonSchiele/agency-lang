import { describe, it, expect } from "vitest";
import { scrub, githubFailureMessage } from "./errors.js";

describe("scrub", () => {
  it.each([
    ["token ghp_abcdefghij1234567890abcd leaked", "ghp_abcdefghij1234567890abcd"],
    ["github_pat_abcdefghij1234567890abcd here", "github_pat_abcdefghij1234567890abcd"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
  ])("redacts %s", (input, secret) => {
    const out = scrub(input);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret);
  });
  it("leaves ordinary text alone", () => {
    expect(scrub("PR not found")).toBe("PR not found");
  });
});

function headers(entries: Record<string, string> = {}): Headers {
  return new Headers(entries);
}

describe("githubFailureMessage", () => {
  it("401 names all three credential remedies", () => {
    const msg = githubFailureMessage(401, headers(), "{}", "GET", "https://api.github.com/x");
    expect(msg).toMatch(/gh auth login/);
    expect(msg).toMatch(/GITHUB_TOKEN/);
    expect(msg).toMatch(/setSecret/);
  });

  it("403 with exhausted rate limit reports the reset time", () => {
    const msg = githubFailureMessage(
      403,
      headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1756700000" }),
      "{}",
      "GET",
      "https://api.github.com/x",
    );
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toContain("1756700000");
  });

  it("403 without rate-limit exhaustion on a write points at token scope", () => {
    const msg = githubFailureMessage(403, headers(), "{}", "POST", "https://api.github.com/x");
    expect(msg).toMatch(/repo.*scope/i);
  });

  it("404 on a write points at token scope, not just missing resource", () => {
    const msg = githubFailureMessage(404, headers(), "{}", "POST", "https://api.github.com/x");
    expect(msg).toMatch(/repo.*scope/i);
  });

  it("406 on a diff points at ghPrFiles", () => {
    const msg = githubFailureMessage(406, headers(), "{}", "GET", "https://api.github.com/x");
    expect(msg).toMatch(/406/);
    expect(msg).toMatch(/ghPrFiles/);
  });

  it("422 surfaces the errors array", () => {
    const body = JSON.stringify({
      message: "Validation Failed",
      errors: [{ field: "line", code: "invalid" }],
    });
    const msg = githubFailureMessage(422, headers(), body, "POST", "https://api.github.com/x");
    expect(msg).toContain("Validation Failed");
    expect(msg).toContain("line");
  });

  it("scrubs a credential-shaped API message", () => {
    const body = JSON.stringify({ message: "bad token ghp_abcdefghij1234567890abcd" });
    const msg = githubFailureMessage(500, headers(), body, "GET", "https://api.github.com/x");
    expect(msg).toContain("[REDACTED]");
  });
});
