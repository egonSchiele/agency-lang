import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { isSuccess } from "agency-lang/runtime";
import {
  openPullRequest, listPullRequests, commentOnPullRequest, addLabel, requestReview,
} from "../src/prs.js";

const TOKEN = "t";

describe("prs", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

  it("openPullRequest posts and returns number+url", async () => {
    nock("https://api.github.com")
      .post("/repos/o/r/pulls", (b: { title?: string; body?: string; head?: string; base?: string; draft?: boolean }) =>
        b.title === "T" && b.body === "B" && b.head === "h" && b.base === "main" && b.draft === true
      ).reply(201, { number: 7, html_url: "https://github.com/o/r/pull/7" });
    const result = await openPullRequest({
      title: "T", body: "B", head: "h", base: "main", draft: true,
      owner: "o", repo: "r", token: TOKEN,
    });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ number: 7, url: "https://github.com/o/r/pull/7" });
  });

  it("openPullRequest defaults base to repo default branch when omitted", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r").reply(200, { default_branch: "trunk" })
      .post("/repos/o/r/pulls", (b: { base?: string }) => b.base === "trunk")
      .reply(201, { number: 1, html_url: "u" });
    const result = await openPullRequest({ title: "T", body: "B", head: "h", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
  });

  it("openPullRequest applies labels after creation", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r").reply(200, { default_branch: "main" })
      .post("/repos/o/r/pulls").reply(201, { number: 9, html_url: "u" })
      .post("/repos/o/r/issues/9/labels", (b: { labels?: string[] }) => Array.isArray(b.labels) && b.labels.includes("agent"))
      .reply(200, []);
    const result = await openPullRequest({
      title: "T", body: "B", head: "h", labels: ["agent"], owner: "o", repo: "r", token: TOKEN,
    });
    expect(isSuccess(result)).toBe(true);
  });

  it("listPullRequests passes state/base/head", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r/pulls").query({ state: "open", base: "main" })
      .reply(200, [{ number: 1, title: "x", body: "", user: { login: "a" },
                    head: { ref: "h" }, base: { ref: "main" }, labels: [],
                    html_url: "u", state: "open", created_at: "2026-01-01T00:00:00Z" }]);
    const result = await listPullRequests({ state: "open", base: "main", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].number).toBe(1);
    }
  });

  it("commentOnPullRequest posts to issues comments endpoint", async () => {
    nock("https://api.github.com")
      .post("/repos/o/r/issues/3/comments", (b: { body?: string }) => b.body === "hi").reply(201, {});
    const result = await commentOnPullRequest({ number: 3, body: "hi", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
  });

  it("addLabel posts labels", async () => {
    nock("https://api.github.com")
      .post("/repos/o/r/issues/3/labels", (b: { labels?: string[] }) => Array.isArray(b.labels) && b.labels.includes("bug"))
      .reply(200, []);
    const result = await addLabel({ number: 3, labels: ["bug"], owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
  });

  it("requestReview posts reviewers + team_reviewers", async () => {
    nock("https://api.github.com")
      .post("/repos/o/r/pulls/3/requested_reviewers", (b: { reviewers?: string[]; team_reviewers?: string[] }) =>
        !!b.reviewers?.includes("alice") && !!b.team_reviewers?.includes("core"))
      .reply(201, {});
    const result = await requestReview({
      number: 3, reviewers: ["alice"], teamReviewers: ["core"],
      owner: "o", repo: "r", token: TOKEN,
    });
    expect(isSuccess(result)).toBe(true);
  });
});
