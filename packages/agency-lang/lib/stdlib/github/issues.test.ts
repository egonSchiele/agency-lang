import { describe, it, expect, afterEach, vi } from "vitest";
import { withCtx, jsonResponse, stubToken } from "./testUtils.js";
import { _resetGithubCredentialCacheForTests } from "./credential.js";
import {
  _ghIssueGet,
  _ghIssueList,
  _ghIssueComments,
  _ghIssueSearch,
  _ghScopedSearchQuery,
} from "./issues.js";

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

  it("refuses to return a pull request as an issue", async () => {
    stubToken();
    const pr = { ...rawIssue, pull_request: { url: "https://api.github.com/x" } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(pr));
    await expect(withCtx(() => _ghIssueGet(42, "o", "r"))).rejects.toThrow(
      /#42 is a pull request.*ghPrGet/s,
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

  it("drops pull requests from the issues list", async () => {
    stubToken();
    const pr = { ...rawIssue, number: 43, pull_request: { url: "https://api.github.com/x" } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([rawIssue, pr]));
    const issues = await withCtx(() => _ghIssueList("open", [], 30, 1, "o", "r"));
    expect(issues.map((issue) => issue.number)).toEqual([42]);
  });

  it("sends the scoped query verbatim and maps the items array", async () => {
    stubToken();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ total_count: 1, items: [rawIssue] }));
    const found = await withCtx(() => _ghIssueSearch("repo:o/r crash", 30, 1));
    expect(found.map((issue) => issue.number)).toEqual([42]);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/search/issues?");
    expect(url).toContain("q=repo%3Ao%2Fr+crash");
  });

  it("keeps pull requests in search results", async () => {
    stubToken();
    const pr = { ...rawIssue, number: 43, pull_request: { url: "https://api.github.com/x" } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [rawIssue, pr] }));
    const found = await withCtx(() => _ghIssueSearch("repo:o/r crash", 30, 1));
    expect(found.map((issue) => issue.number)).toEqual([42, 43]);
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

describe("_ghScopedSearchQuery", () => {
  it("confines the query to one repository", () => {
    expect(_ghScopedSearchQuery("o", "r", "crash label:bug")).toBe("repo:o/r crash label:bug");
  });

  it.each([
    ["repo:other/private secret"],
    ["secret repo:other/private"],
    ["REPO:other/private secret"],
    ["-repo:o/r secret"],
    ["org:other secret"],
    ["user:someone secret"],
    ["crash OR (repo:other/private crash)"],
  ])("refuses a query with its own scope qualifier: %s", (query) => {
    expect(() => _ghScopedSearchQuery("o", "r", query)).toThrow(/repo:, org:, or user:/);
  });

  it("allows a qualifier name inside a word", () => {
    expect(_ghScopedSearchQuery("o", "r", "subrepo:thing")).toBe("repo:o/r subrepo:thing");
  });
});
