import { describe, it, expect, afterEach, vi } from "vitest";
import { withCtx, jsonResponse, stubToken } from "./testUtils.js";
import { _resetGithubCredentialCacheForTests } from "./credential.js";
import { _ghPrGet, _ghPrList, _ghPrChecks, _ghPrFiles, _ghPrDiff } from "./prs.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetGithubCredentialCacheForTests();
});

const rawPr = {
  number: 7,
  title: "Add feature",
  state: "open",
  user: { login: "alice" },
  base: { ref: "main" },
  head: { ref: "feat", sha: "abc123" },
  draft: false,
  body: "the body",
  html_url: "https://github.com/o/r/pull/7",
  additions: 10,
  deletions: 2,
  changed_files: 3,
};

describe("PR endpoints", () => {
  it("validates and transforms a raw PR to PrSummary", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(rawPr));
    const pr = await withCtx(() => _ghPrGet(7, "o", "r"));
    expect(pr).toEqual({
      number: 7,
      title: "Add feature",
      state: "open",
      author: "alice",
      base: "main",
      head: "feat",
      headSha: "abc123",
      draft: false,
      body: "the body",
      url: "https://github.com/o/r/pull/7",
      additions: 10,
      deletions: 2,
      changedFiles: 3,
    });
  });

  it("defaults the documented-nullable fields: null body, null user", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...rawPr, body: null, user: null }),
    );
    const pr = await withCtx(() => _ghPrGet(7, "o", "r"));
    expect(pr.body).toBe("");
    expect(pr.author).toBe("");
  });

  it("fails loudly, naming the endpoint, when a required field is missing", async () => {
    stubToken();
    const { title: _dropped, ...withoutTitle } = rawPr;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(withoutTitle));
    await expect(withCtx(() => _ghPrGet(7, "o", "r"))).rejects.toThrow(
      /pulls\/\{number\}.*expected shape.*title/s,
    );
  });

  it("clamps and forwards list paging, and omits an empty base", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([rawPr]));
    await withCtx(() => _ghPrList("open", "", 500, 0, "o", "r"));
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("state=open");
    expect(url).toContain("per_page=100");
    expect(url).toContain("page=1");
    expect(url).not.toContain("base=");
  });

  it("forwards a base branch filter", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    await withCtx(() => _ghPrList("all", "main", 30, 1, "o", "r"));
    expect(String(spy.mock.calls[0][0])).toContain("base=main");
  });

  it("encodes owner and repo into the path", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(rawPr));
    await withCtx(() => _ghPrGet(7, "own er", "re/po"));
    expect(String(spy.mock.calls[0][0])).toContain("/repos/own%20er/re%2Fpo/pulls/7");
  });

  it("requests the diff media type and returns the raw text", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("diff --git a b"));
    const diff = await withCtx(() => _ghPrDiff(7, "o", "r"));
    expect(diff).toBe("diff --git a b");
    const headers = spy.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.github.v3.diff");
  });

  it("maps changed files, defaulting a missing patch (binary file) to empty", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        { filename: "a.ts", status: "modified", additions: 1, deletions: 2, patch: "@@" },
        { filename: "img.png", status: "added", additions: 0, deletions: 0 },
      ]),
    );
    const files = await withCtx(() => _ghPrFiles(7, 100, 1, "o", "r"));
    expect(files).toEqual([
      { path: "a.ts", status: "modified", additions: 1, deletions: 2, patch: "@@" },
      { path: "img.png", status: "added", additions: 0, deletions: 0, patch: "" },
    ]);
  });

  it("resolves the head SHA then fetches check runs: two requests, in order", async () => {
    stubToken();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(rawPr))
      .mockResolvedValueOnce(
        jsonResponse({
          check_runs: [
            { name: "ci", status: "completed", conclusion: "success", html_url: "https://x" },
          ],
        }),
      );
    const runs = await withCtx(() => _ghPrChecks(7, "o", "r"));
    expect(runs).toEqual([
      { name: "ci", status: "completed", conclusion: "success", url: "https://x" },
    ]);
    expect(String(spy.mock.calls[0][0])).toContain("/pulls/7");
    expect(String(spy.mock.calls[1][0])).toContain("/commits/abc123/check-runs");
  });
});
