import { describe, it, expect } from "vitest";
import { isSuccess } from "agency-lang/runtime";
import { parseRemoteUrl, resolveRepo } from "../../src/internal/repo.js";

describe("parseRemoteUrl", () => {
  it("parses HTTPS URL", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("parses HTTPS URL without .git", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("parses SSH URL", () => {
    expect(parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("returns undefined for non-github URL", () => {
    expect(parseRemoteUrl("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });
});

describe("resolveRepo", () => {
  it("uses override when provided", async () => {
    const result = await resolveRepo({ owner: "a", repo: "b" });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ owner: "a", repo: "b" });
  });
});
