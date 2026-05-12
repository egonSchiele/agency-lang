import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { isSuccess } from "agency-lang/runtime";
import { defaultBranch } from "../src/meta.js";

describe("defaultBranch", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

  it("returns the default branch", async () => {
    nock("https://api.github.com").get("/repos/o/r").reply(200, { default_branch: "trunk" });
    const result = await defaultBranch({ owner: "o", repo: "r", token: "t" });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toBe("trunk");
  });
});
