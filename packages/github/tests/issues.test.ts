import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { isSuccess } from "agency-lang/runtime";
import { listIssues, commentOnIssue, createIssue } from "../src/issues.js";

const TOKEN = "t";

describe("issues", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

  it("listIssues filters out PRs (which the issues endpoint includes)", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r/issues").query(true)
      .reply(200, [
        { number: 1, title: "a", body: "", user: { login: "u" }, labels: [],
          html_url: "u", state: "open", created_at: "2026-01-01T00:00:00Z" },
        { number: 2, title: "pr", body: "", user: { login: "u" }, labels: [],
          html_url: "u", state: "open", created_at: "2026-01-01T00:00:00Z",
          pull_request: { url: "..." } },
      ]);
    const result = await listIssues({ owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].number).toBe(1);
    }
  });

  it("commentOnIssue posts comment", async () => {
    nock("https://api.github.com")
      .post("/repos/o/r/issues/4/comments", (b: { body?: string }) => b.body === "hi").reply(201, {});
    const result = await commentOnIssue({ number: 4, body: "hi", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
  });

  it("createIssue posts and returns Issue", async () => {
    nock("https://api.github.com")
      .post("/repos/o/r/issues", (b: { title?: string; body?: string }) => b.title === "T" && b.body === "B")
      .reply(201, {
        number: 9, title: "T", body: "B", user: { login: "u" }, labels: [],
        html_url: "u", state: "open", created_at: "2026-01-01T00:00:00Z",
      });
    const result = await createIssue({ title: "T", body: "B", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value.number).toBe(9);
  });
});
