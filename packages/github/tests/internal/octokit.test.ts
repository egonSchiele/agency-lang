import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSuccess, isFailure } from "agency-lang/runtime";
import { resolveToken, getOctokit } from "../../src/internal/octokit.js";

describe("resolveToken", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => { savedEnv = { ...process.env }; delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; });
  afterEach(() => { process.env = savedEnv; });

  it("uses explicit token first", () => {
    process.env.GITHUB_TOKEN = "from-env";
    expect(resolveToken("explicit")).toBe("explicit");
  });
  it("falls back to GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "gh";
    expect(resolveToken()).toBe("gh");
  });
  it("falls back to GH_TOKEN if GITHUB_TOKEN missing", () => {
    process.env.GH_TOKEN = "cli";
    expect(resolveToken()).toBe("cli");
  });
  it("returns undefined when nothing is set", () => {
    expect(resolveToken()).toBeUndefined();
  });
});

describe("getOctokit", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => { savedEnv = { ...process.env }; delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; });
  afterEach(() => { process.env = savedEnv; });

  it("returns failure when no token", () => {
    const result = getOctokit();
    expect(isFailure(result)).toBe(true);
  });
  it("returns success when token provided", () => {
    expect(isSuccess(getOctokit("explicit"))).toBe(true);
  });
});
