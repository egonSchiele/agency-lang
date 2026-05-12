import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { success, isSuccess, isFailure } from "agency-lang/runtime";
import { withCtx } from "../../src/internal/withCtx.js";
import type { Result } from "../../src/internal/result.js";

describe("withCtx", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => { savedEnv = { ...process.env }; delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; });
  afterEach(() => { process.env = savedEnv; });

  it("propagates failure when no token", async () => {
    const result = await withCtx({ owner: "o", repo: "r" }, async () => success(1) as Result<number>);
    expect(isFailure(result)).toBe(true);
  });

  it("does NOT invoke fn when token is missing", async () => {
    const fn = vi.fn(async () => success(1) as Result<number>);
    await withCtx({ owner: "o", repo: "r" }, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn with octokit + owner + repo on full happy path", async () => {
    let captured: { owner: string; repo: string } | undefined;
    const result = await withCtx({ owner: "o", repo: "r", token: "t" }, async (_octokit, owner, repo) => {
      captured = { owner, repo };
      return success("ok") as Result<string>;
    });
    expect(captured).toEqual({ owner: "o", repo: "r" });
    expect(isSuccess(result)).toBe(true);
  });
});
