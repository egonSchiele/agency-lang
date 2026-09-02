import { describe, it, expect } from "vitest";
import { parseRemoteUrl, redactUrl, _ghResolveRepo } from "./repo.js";
import { withCtx, makeCtx } from "./testUtils.js";
import { ThreadStore } from "../../runtime/state/threadStore.js";
import { runInTestContext } from "../../runtime/asyncContext.js";
import { AgencyCancelledError } from "../../runtime/errors.js";

describe("parseRemoteUrl", () => {
  it.each([
    ["https://github.com/egonSchiele/agency-lang", "egonSchiele", "agency-lang"],
    ["https://github.com/egonSchiele/agency-lang.git", "egonSchiele", "agency-lang"],
    ["https://github.com/egonSchiele/agency-lang/", "egonSchiele", "agency-lang"],
    ["https://github.com/o/repo.with.dots", "o", "repo.with.dots"],
    ["git@github.com:egonSchiele/agency-lang.git", "egonSchiele", "agency-lang"],
    ["git@github.com:o/repo.with.dots", "o", "repo.with.dots"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseRemoteUrl(url)).toEqual({ owner, repo });
  });

  it.each([["https://gitlab.com/o/r"], ["https://github.com/only-owner"], ["not a url"], [""]])(
    "refuses %s",
    (url) => {
      expect(parseRemoteUrl(url)).toBeUndefined();
    },
  );
});

describe("redactUrl", () => {
  it("strips embedded credentials", () => {
    expect(redactUrl("https://user:ghp_secret123@github.com/o/r")).toBe("https://github.com/o/r");
  });
  it("passes a credential-free URL through", () => {
    expect(redactUrl("https://github.com/o/r")).toBe("https://github.com/o/r");
  });
  it("strips credentials from a URL the URL parser refuses", () => {
    // The invalid port makes `new URL` throw; the userinfo must still go.
    expect(redactUrl("https://user:ghp_secret123@github.com:bad/o/r")).toBe(
      "https://github.com:bad/o/r",
    );
  });
  it("strips userinfo that itself contains an @", () => {
    expect(redactUrl("https://user@example.com:ghp_secret123@github.com:bad/o/r")).toBe(
      "https://github.com:bad/o/r",
    );
  });
  it("passes an unparseable SSH remote through", () => {
    expect(redactUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("_ghResolveRepo", () => {
  it("returns an explicit pair without touching git", async () => {
    // Empty cwd would make the git runner throw, so this passing proves the
    // explicit pair short-circuits before any subprocess.
    expect(await _ghResolveRepo("o", "r", "")).toEqual({ owner: "o", repo: "r" });
  });
  it.each([
    ["own er", "r"],
    ["o", "re/po"],
    ["o", "r OR repo:other/private"],
    ["-dash-first", "r"],
    ["dash-last-", "r"],
    ["double--dash", "r"],
    ["", "r"],
  ])("refuses an explicit pair GitHub could not have issued: %s/%s", async (owner, repo) => {
    await expect(_ghResolveRepo(owner, repo, "")).rejects.toThrow();
  });
  it("accepts dots, underscores, and hyphens in a repo name", async () => {
    expect(await _ghResolveRepo("my-org", "a.b_c-d", "")).toEqual({
      owner: "my-org",
      repo: "a.b_c-d",
    });
  });
  it("rejects a one-sided override", async () => {
    await expect(_ghResolveRepo("o", "", "")).rejects.toThrow(/both owner and repo/);
    await expect(_ghResolveRepo("", "r", "")).rejects.toThrow(/both owner and repo/);
  });
  it("refuses an empty cwd instead of falling back to process.cwd()", async () => {
    // _gitRun's contract: a lost directory must never silently target the
    // process's own repo — that would mispin @always(owner, repo).
    await expect(withCtx(() => _ghResolveRepo("", "", ""))).rejects.toThrow();
  });
  it("keeps a cancellation abort-shaped instead of wrapping it as a repo failure", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext({ runId: "github-cancel" });
    execCtx.cancel("test stop");
    // process.cwd() is a real repo, so the only reason to fail is the abort.
    await expect(
      runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), () =>
        _ghResolveRepo("", "", process.cwd()),
      ),
    ).rejects.toBeInstanceOf(AgencyCancelledError);
  });
  it("fails with an actionable message outside a git repo", async () => {
    // "/" is absolute and exists but is not a repository.
    await expect(withCtx(() => _ghResolveRepo("", "", "/"))).rejects.toThrow(
      /owner and repo explicitly/,
    );
  });
});
