import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { isSuccess, isFailure } from "agency-lang/runtime";
import { createBranch, branchExists, deleteBranch } from "../src/branches.js";

const TOKEN = "test-token";

describe("branches", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

  it("createBranch creates from default branch when from omitted", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r").reply(200, { default_branch: "main" })
      .get("/repos/o/r/git/ref/heads%2Fmain").reply(200, { object: { sha: "abc" } })
      .post("/repos/o/r/git/refs", (body: { ref?: string; sha?: string }) =>
        body.ref === "refs/heads/feat" && body.sha === "abc"
      ).reply(201, {});
    const result = await createBranch({ name: "feat", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
  });

  it("branchExists returns true for 200", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r/git/ref/heads%2Ffeat").reply(200, {});
    const result = await branchExists({ name: "feat", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toBe(true);
  });

  it("branchExists returns false for 404", async () => {
    nock("https://api.github.com")
      .get("/repos/o/r/git/ref/heads%2Fmissing").reply(404);
    const result = await branchExists({ name: "missing", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toBe(false);
  });

  it("deleteBranch DELETEs the ref", async () => {
    nock("https://api.github.com")
      .delete("/repos/o/r/git/refs/heads%2Ffeat").reply(204);
    const result = await deleteBranch({ name: "feat", owner: "o", repo: "r", token: TOKEN });
    expect(isSuccess(result)).toBe(true);
  });

  it("createBranch rejects an injected ref name", async () => {
    const result = await createBranch({ name: "--upload-pack=evil", owner: "o", repo: "r", token: TOKEN });
    expect(isFailure(result)).toBe(true);
  });
});
