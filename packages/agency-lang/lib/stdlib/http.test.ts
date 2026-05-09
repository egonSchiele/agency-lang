import { describe, it, expect } from "vitest";
import { resolveUrl, checkAllowedDomains } from "./http.js";

describe("resolveUrl", () => {
  it("joins baseUrl and path", () => {
    expect(resolveUrl("https://api.github.com", "/repos")).toBe(
      "https://api.github.com/repos",
    );
  });

  it("uses baseUrl alone when path is empty", () => {
    expect(resolveUrl("https://api.github.com", "")).toBe(
      "https://api.github.com",
    );
  });

  it("handles trailing slash on baseUrl", () => {
    expect(resolveUrl("https://api.github.com/", "/repos")).toBe(
      "https://api.github.com/repos",
    );
  });

  it("handles path without leading slash", () => {
    expect(resolveUrl("https://api.github.com", "repos")).toBe(
      "https://api.github.com/repos",
    );
  });

  it("handles both trailing and leading slashes", () => {
    expect(resolveUrl("https://api.github.com/", "repos")).toBe(
      "https://api.github.com/repos",
    );
  });
});

describe("checkAllowedDomains", () => {
  it("returns null when allowedDomains is empty", () => {
    expect(checkAllowedDomains("https://evil.com", [])).toBeNull();
  });

  it("returns null when domain is in list", () => {
    expect(
      checkAllowedDomains("https://api.github.com/repos", [
        "api.github.com",
      ]),
    ).toBeNull();
  });

  it("returns error when domain is not in list", () => {
    const result = checkAllowedDomains("https://evil.com/data", [
      "api.github.com",
    ]);
    expect(result).toContain("evil.com");
    expect(result).toContain("not in allowedDomains");
  });

  it("is case-insensitive", () => {
    expect(
      checkAllowedDomains("https://API.GitHub.COM/repos", [
        "api.github.com",
      ]),
    ).toBeNull();
  });

  it("returns error for invalid URL", () => {
    const result = checkAllowedDomains("not-a-url", ["example.com"]);
    expect(result).toContain("Invalid URL");
  });

  it("allows any of multiple domains", () => {
    expect(
      checkAllowedDomains("https://b.com/data", ["a.com", "b.com", "c.com"]),
    ).toBeNull();
  });
});
