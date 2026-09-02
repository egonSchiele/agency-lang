import { describe, it, expect, afterEach, vi } from "vitest";
import { withCtx, jsonResponse, stubToken } from "./testUtils.js";
import { _resetGithubCredentialCacheForTests } from "./credential.js";
import { _ghIssueGet, _ghIssueList, _ghIssueComments, _ghIssueSearch } from "./issues.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetGithubCredentialCacheForTests();
});

const rawIssue = {
  number: 42,
  title: "Crash on start",
  state: "open",
  user: { login: "bob" },
  labels: [{ name: "bug" }, "typo"],
  assignees: [{ login: "a" }],
  body: null,
  html_url: "https://github.com/o/r/issues/42",
};

describe("issue endpoints", () => {
  it("validates and transforms a raw issue to IssueSummary", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(rawIssue));
    const issue = await withCtx(() => _ghIssueGet(42, "o", "r"));
    expect(issue).toEqual({
      number: 42,
      title: "Crash on start",
      state: "open",
      author: "bob",
      labels: ["bug", "typo"],
      assignees: ["a"],
      body: "",
      url: "https://github.com/o/r/issues/42",
    });
  });

  it("fails loudly, naming the endpoint, when a required field is missing", async () => {
    stubToken();
    const { number: _dropped, ...withoutNumber } = rawIssue;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(withoutNumber));
    await expect(withCtx(() => _ghIssueGet(42, "o", "r"))).rejects.toThrow(
      /issues\/\{number\}.*expected shape/s,
    );
  });

  it("forwards state, comma-joined labels, and clamped paging", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([rawIssue]));
    await withCtx(() => _ghIssueList("closed", ["bug", "p1"], 500, 0, "o", "r"));
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/repos/o/r/issues?");
    expect(url).toContain("state=closed");
    expect(url).toContain("labels=bug%2Cp1");
    expect(url).toContain("per_page=100");
    expect(url).toContain("page=1");
  });

  it("omits the labels parameter when none are given", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    await withCtx(() => _ghIssueList("open", [], 30, 1, "o", "r"));
    expect(String(spy.mock.calls[0][0])).not.toContain("labels=");
  });

  it("scopes a search to the repository and maps the items array", async () => {
    stubToken();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ total_count: 1, items: [rawIssue] }));
    const found = await withCtx(() => _ghIssueSearch("crash", 30, 1, "o", "r"));
    expect(found.map((issue) => issue.number)).toEqual([42]);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/search/issues?");
    expect(url).toContain(`q=${encodeURIComponent("repo:o/r crash").replace(/%20/g, "+")}`);
  });

  it("pages issue comments", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          id: 1,
          user: { login: "c" },
          body: "hi",
          created_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/o/r/issues/42#issuecomment-1",
        },
      ]),
    );
    const comments = await withCtx(() => _ghIssueComments(42, 50, 2, "o", "r"));
    expect(comments).toEqual([
      {
        id: 1,
        author: "c",
        body: "hi",
        createdAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/o/r/issues/42#issuecomment-1",
      },
    ]);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/repos/o/r/issues/42/comments?");
    expect(url).toContain("per_page=50");
    expect(url).toContain("page=2");
  });
});
