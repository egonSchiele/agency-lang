import { describe, it, expect, vi } from "vitest";
import { promisify } from "util";
import { isSuccess, isFailure } from "agency-lang/runtime";

vi.mock("child_process", () => {
  let impl: ((args: string[]) => { stdout: string; stderr: string } | { error: Error }) | null = null;
  const execFile = (..._args: unknown[]): unknown => undefined;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (_cmd: string, args: string[]) => {
      if (!impl) throw new Error("execFile mock not initialized");
      const out = impl(args);
      if ("error" in out) throw out.error;
      return out;
    },
  });
  return {
    execFile,
    __setExecFileImpl: (fn: typeof impl) => { impl = fn; },
  };
});

import * as cp from "child_process";
import { parseRemoteUrl, resolveRepo } from "../../src/internal/repo.js";

type MockResult = { stdout: string; stderr: string } | { error: Error };
const setExecFile = (fn: (args: string[]) => MockResult): void => {
  (cp as unknown as { __setExecFileImpl: (fn: (args: string[]) => MockResult) => void }).__setExecFileImpl(fn);
};

describe("parseRemoteUrl", () => {
  it("parses HTTPS URL", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("parses HTTPS URL without .git", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("parses HTTPS URL with trailing slash", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("parses SSH URL", () => {
    expect(parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("parses SSH URL without .git", () => {
    expect(parseRemoteUrl("git@github.com:owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("returns undefined for non-github URL", () => {
    expect(parseRemoteUrl("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });
  it("returns undefined for malformed URL", () => {
    expect(parseRemoteUrl("not a url at all")).toBeUndefined();
  });
  it("allows dots in repo names (HTTPS)", () => {
    expect(parseRemoteUrl("https://github.com/owner/foo.bar.git")).toEqual({ owner: "owner", repo: "foo.bar" });
    expect(parseRemoteUrl("https://github.com/owner/foo.bar")).toEqual({ owner: "owner", repo: "foo.bar" });
  });
  it("allows dots in repo names (SSH)", () => {
    expect(parseRemoteUrl("git@github.com:owner/foo.bar.git")).toEqual({ owner: "owner", repo: "foo.bar" });
  });
});

describe("resolveRepo", () => {
  it("uses override when provided (no shell-out)", async () => {
    setExecFile(() => { throw new Error("should not be called"); });
    const result = await resolveRepo({ owner: "a", repo: "b" });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ owner: "a", repo: "b" });
  });

  it("shells out to git when override missing and parses HTTPS remote", async () => {
    setExecFile((args) => {
      expect(args).toEqual(["remote", "get-url", "origin"]);
      return { stdout: "https://github.com/foo/bar.git\n", stderr: "" };
    });
    const result = await resolveRepo();
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ owner: "foo", repo: "bar" });
  });

  it("shells out to git when override missing and parses SSH remote", async () => {
    setExecFile(() => ({ stdout: "git@github.com:foo/bar.git\n", stderr: "" }));
    const result = await resolveRepo();
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ owner: "foo", repo: "bar" });
  });

  it("returns failure when git command fails (e.g. not a git repo)", async () => {
    setExecFile(() => ({ error: new Error("fatal: not a git repository") }));
    const result = await resolveRepo();
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(String(result.error)).toContain("git remote 'origin'");
  });

  it("returns failure when remote URL is non-GitHub (unparseable)", async () => {
    setExecFile(() => ({ stdout: "https://gitlab.com/foo/bar.git\n", stderr: "" }));
    const result = await resolveRepo();
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(String(result.error)).toContain("Could not parse");
  });

  it("redacts credentials embedded in the origin URL when emitting failure", async () => {
    setExecFile(() => ({ stdout: "https://x-access-token:hunter2@gitlab.com/foo/bar.git\n", stderr: "" }));
    const result = await resolveRepo();
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(String(result.error)).not.toContain("hunter2");
      expect(String(result.error)).not.toContain("x-access-token");
    }
  });

  it("falls back to shell-out when override is partial (only owner)", async () => {
    setExecFile(() => ({ stdout: "https://github.com/from-git/repo.git\n", stderr: "" }));
    const result = await resolveRepo({ owner: "ignored-because-repo-missing" });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ owner: "from-git", repo: "repo" });
  });
});
