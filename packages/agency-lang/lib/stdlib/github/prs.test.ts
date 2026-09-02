import { describe, it, expect, afterEach, vi } from "vitest";
import { withCtx, jsonResponse, stubToken } from "./testUtils.js";
import { _resetGithubCredentialCacheForTests } from "./credential.js";
import {
  _ghPrGet,
  _ghPrList,
  _ghPrChecks,
  _ghPrFiles,
  _ghPrDiff,
  _ghPrReviews,
  _ghPrReviewComments,
  _ghPrComment,
  _ghPrReviewComment,
  _ghPrReview,
  _ghPrApprove,
} from "./prs.js";

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

  it("fails loudly when a get response lacks the change counts", async () => {
    stubToken();
    const { additions: _dropped, ...withoutAdditions } = rawPr;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(withoutAdditions));
    await expect(withCtx(() => _ghPrGet(7, "o", "r"))).rejects.toThrow(
      /pulls\/\{number\}.*expected shape.*additions/s,
    );
  });

  it("maps a list item, which GitHub sends without change counts", async () => {
    stubToken();
    const { additions: _a, deletions: _d, changed_files: _c, ...rawListItem } = rawPr;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([rawListItem]));
    const [item] = await withCtx(() => _ghPrList("open", "", 30, 1, "o", "r"));
    expect(item).toEqual({
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
    });
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
    const runs = await withCtx(() => _ghPrChecks(7, 50, 2, "o", "r"));
    expect(runs).toEqual([
      { name: "ci", status: "completed", conclusion: "success", url: "https://x" },
    ]);
    expect(String(spy.mock.calls[0][0])).toContain("/pulls/7");
    expect(String(spy.mock.calls[1][0])).toContain("/commits/abc123/check-runs?per_page=50&page=2");
  });

  it("accepts a pending review, which has a null submitted_at", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        { id: 1, user: { login: "r" }, state: "PENDING", body: null, submitted_at: null },
      ]),
    );
    const reviews = await withCtx(() => _ghPrReviews(7, 30, 1, "o", "r"));
    expect(reviews).toEqual([{ id: 1, author: "r", state: "PENDING", body: "", submittedAt: "" }]);
  });

  it("pages reviews and review comments", async () => {
    stubToken();
    // A fresh Response per call: a body can only be read once.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));
    await withCtx(() => _ghPrReviews(7, 50, 2, "o", "r"));
    await withCtx(() => _ghPrReviewComments(7, 25, 3, "o", "r"));
    expect(String(spy.mock.calls[0][0])).toContain("/pulls/7/reviews?per_page=50&page=2");
    expect(String(spy.mock.calls[1][0])).toContain("/pulls/7/comments?per_page=25&page=3");
  });
});

const rawComment = {
  id: 1,
  user: { login: "agency-bot" },
  body: "hi",
  created_at: "2026-09-01T00:00:00Z",
  html_url: "https://github.com/o/r/pull/7#issuecomment-1",
};

const rawReviewComment = {
  id: 2,
  path: "a.ts",
  line: 3,
  user: { login: "agency-bot" },
  body: "x",
  html_url: "https://github.com/o/r/pull/7#discussion_r2",
};

const rawReview = {
  id: 3,
  user: { login: "agency-bot" },
  state: "COMMENTED",
  body: "overall",
  submitted_at: "2026-09-01T00:00:00Z",
};

function sentBody(spy: ReturnType<typeof vi.spyOn>, call: number): unknown {
  const init = spy.mock.calls[call][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("PR write endpoints", () => {
  it("posts a top-level comment to the issues endpoint and maps the result", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(rawComment, 201));
    const comment = await withCtx(() => _ghPrComment(7, "hi", "o", "r"));
    expect(String(spy.mock.calls[0][0])).toContain("/repos/o/r/issues/7/comments");
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(sentBody(spy, 0)).toEqual({ body: "hi" });
    expect(comment.author).toBe("agency-bot");
  });

  it("resolves the head SHA first when no commitSha is given: two calls, in order", async () => {
    stubToken();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(rawPr))
      .mockResolvedValueOnce(jsonResponse(rawReviewComment, 201));
    await withCtx(() => _ghPrReviewComment(7, "a.ts", 3, "x", "RIGHT", "", "o", "r"));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0][0])).toContain("/pulls/7");
    expect(String(spy.mock.calls[1][0])).toContain("/pulls/7/comments");
    expect(sentBody(spy, 1)).toEqual({
      path: "a.ts",
      line: 3,
      side: "RIGHT",
      commit_id: "abc123",
      body: "x",
    });
  });

  it("makes exactly one call when commitSha is explicit", async () => {
    stubToken();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(rawReviewComment, 201));
    await withCtx(() => _ghPrReviewComment(7, "a.ts", 3, "x", "LEFT", "def456", "o", "r"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy, 0)).toMatchObject({ commit_id: "def456", side: "LEFT" });
  });

  it("submits a review with its inline comments, defaulting side to RIGHT", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(rawReview));
    const review = await withCtx(() =>
      _ghPrReview(7, "COMMENT", "overall", [{ path: "a.ts", line: 3, body: "x" }], "o", "r"),
    );
    expect(String(spy.mock.calls[0][0])).toContain("/pulls/7/reviews");
    expect(sentBody(spy, 0)).toEqual({
      event: "COMMENT",
      body: "overall",
      comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "x" }],
    });
    expect(review.state).toBe("COMMENTED");
  });

  it("refuses event APPROVE without fetching", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(withCtx(() => _ghPrReview(7, "APPROVE", "", [], "o", "r"))).rejects.toThrow(
      /ghPrApprove/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("approves with event APPROVE", async () => {
    stubToken();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ...rawReview, state: "APPROVED" }));
    const review = await withCtx(() => _ghPrApprove(7, "lgtm", "o", "r"));
    expect(String(spy.mock.calls[0][0])).toContain("/pulls/7/reviews");
    expect(sentBody(spy, 0)).toMatchObject({ event: "APPROVE", body: "lgtm" });
    expect(review.state).toBe("APPROVED");
  });
});
