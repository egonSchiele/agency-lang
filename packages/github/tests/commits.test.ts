import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSuccess, isFailure, success } from "agency-lang/runtime";
import * as gitMod from "../src/internal/git.js";
import { commitFiles } from "../src/commits.js";

describe("commitFiles", () => {
  let invocations: string[][] = [];

  beforeEach(() => {
    invocations = [];
    vi.spyOn(gitMod, "runGit").mockImplementation(async (args: string[]) => {
      invocations.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return success({ stdout: "newsha\n", stderr: "" }) as ReturnType<typeof gitMod.runGit> extends Promise<infer R> ? R : never;
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return success({ stdout: "main\n", stderr: "" }) as ReturnType<typeof gitMod.runGit> extends Promise<infer R> ? R : never;
      }
      return success({ stdout: "", stderr: "" }) as ReturnType<typeof gitMod.runGit> extends Promise<infer R> ? R : never;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.AGENCY_RUN_ACTION_VERSION; });

  it("checks out branch when specified", async () => {
    await commitFiles({ message: "m", branch: "feat", push: false });
    expect(invocations).toContainEqual(["checkout", "-B", "feat"]);
  });

  it("git add -u when files omitted", async () => {
    await commitFiles({ message: "m", push: false });
    expect(invocations).toContainEqual(["add", "-u"]);
  });

  it("git add -- <files> when files specified (-- prevents flag injection)", async () => {
    await commitFiles({ message: "m", files: ["a.txt", "--evil"], push: false });
    expect(invocations).toContainEqual(["add", "--", "a.txt", "--evil"]);
  });

  it("uses default author and trailer 'local' when env unset", async () => {
    await commitFiles({ message: "m", push: false });
    const commit = invocations.find((c) => c[0] === "-c" && c[1].startsWith("user.name="));
    expect(commit).toBeDefined();
    expect(commit).toContain("user.name=Agency Lang Agent");
    const trailer = commit!.find((a) => a.startsWith("Generated-by-Agency-Action: "));
    expect(trailer).toBe("Generated-by-Agency-Action: local");
  });

  it("uses AGENCY_RUN_ACTION_VERSION when set", async () => {
    process.env.AGENCY_RUN_ACTION_VERSION = "v1.2.3";
    await commitFiles({ message: "m", push: false });
    const commit = invocations.find((c) => c[0] === "-c");
    const trailer = commit!.find((a) => a.startsWith("Generated-by-Agency-Action: "));
    expect(trailer).toBe("Generated-by-Agency-Action: egonSchiele/run-agency-action@v1.2.3");
  });

  it("pushes with --set-upstream by default; never --force", async () => {
    await commitFiles({ message: "m", branch: "feat" });
    const push = invocations.find((c) => c[0] === "push");
    expect(push).toEqual(["push", "--set-upstream", "origin", "feat"]);
    expect(invocations.some((c) => c.includes("--force") || c.includes("--force-with-lease"))).toBe(false);
  });

  it("captures HEAD sha into success value", async () => {
    const result = await commitFiles({ message: "m", push: false });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toEqual({ sha: "newsha" });
  });

  it("rejects an injected branch name", async () => {
    const result = await commitFiles({ message: "m", branch: "--upload-pack=evil", push: false });
    expect(isFailure(result)).toBe(true);
  });
});
