import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSuccess, isFailure, success, failure } from "agency-lang/runtime";
import * as gitMod from "../src/internal/git.js";
import { commitFiles } from "../src/commits.js";

type RunGitResult = Awaited<ReturnType<typeof gitMod.runGit>>;
const ok = (stdout = ""): RunGitResult => success({ stdout, stderr: "" }) as RunGitResult;
const err = (msg: string): RunGitResult => failure(msg) as RunGitResult;

// Default mock: every command succeeds. `rev-parse HEAD` returns a stable sha;
// `rev-parse --abbrev-ref HEAD` returns "main" so the no-branch+push path can
// be exercised without checking out anything.
function defaultRunGitMock(invocations: string[][]) {
  return async (args: string[]): Promise<RunGitResult> => {
    invocations.push(args);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("newsha\n");
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok("main\n");
    return ok();
  };
}

describe("commitFiles", () => {
  let invocations: string[][] = [];

  beforeEach(() => {
    invocations = [];
    vi.spyOn(gitMod, "runGit").mockImplementation(defaultRunGitMock(invocations));
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

  // ─── Author-arg precedence (Agency wrapper compatibility) ────────────────

  it("authorName/authorEmail map to user.name/user.email", async () => {
    await commitFiles({ message: "m", authorName: "Alice", authorEmail: "alice@example.com", push: false });
    const commit = invocations.find((c) => c[0] === "-c" && c[1].startsWith("user.name="));
    expect(commit).toContain("user.name=Alice");
    expect(commit).toContain("user.email=alice@example.com");
  });

  it("explicit author object takes precedence over authorName/authorEmail", async () => {
    await commitFiles({
      message: "m",
      author: { name: "Bob", email: "bob@example.com" },
      authorName: "Alice",
      authorEmail: "alice@example.com",
      push: false,
    });
    const commit = invocations.find((c) => c[0] === "-c" && c[1].startsWith("user.name="));
    expect(commit).toContain("user.name=Bob");
    expect(commit).toContain("user.email=bob@example.com");
  });

  it("empty authorName falls through to default author", async () => {
    await commitFiles({ message: "m", authorName: "", authorEmail: "", push: false });
    const commit = invocations.find((c) => c[0] === "-c" && c[1].startsWith("user.name="));
    expect(commit).toContain("user.name=Agency Lang Agent");
  });

  // ─── currentBranch helper (no-branch + push path) ────────────────────────

  it("uses currentBranch from rev-parse when branch is omitted and push is enabled", async () => {
    // push defaults to true; mock returns "main" for rev-parse --abbrev-ref
    await commitFiles({ message: "m" });
    const push = invocations.find((c) => c[0] === "push");
    expect(push).toEqual(["push", "--set-upstream", "origin", "main"]);
    // never tries to checkout anything
    expect(invocations.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("empty-string branch is treated as no branch (no checkout)", async () => {
    await commitFiles({ message: "m", branch: "", push: false });
    expect(invocations.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("files: [] (empty array) falls through to git add -u", async () => {
    await commitFiles({ message: "m", files: [], push: false });
    expect(invocations).toContainEqual(["add", "-u"]);
    expect(invocations.some((c) => c[0] === "add" && c[1] === "--")).toBe(false);
  });

  // ─── Failure propagation: each git step short-circuits the chain ─────────

  it("propagates checkout failure and skips add/commit/push", async () => {
    vi.spyOn(gitMod, "runGit").mockImplementation(async (args: string[]) => {
      invocations.push(args);
      if (args[0] === "checkout") return err("checkout boom");
      return ok();
    });
    const result = await commitFiles({ message: "m", branch: "feat", push: false });
    expect(isFailure(result)).toBe(true);
    expect(invocations.find((c) => c[0] === "add")).toBeUndefined();
    expect(invocations.find((c) => c[0] === "commit")).toBeUndefined();
  });

  it("propagates add failure and skips commit/push", async () => {
    vi.spyOn(gitMod, "runGit").mockImplementation(async (args: string[]) => {
      invocations.push(args);
      if (args[0] === "add") return err("add boom");
      return ok();
    });
    const result = await commitFiles({ message: "m", push: false });
    expect(isFailure(result)).toBe(true);
    expect(invocations.find((c) => c.includes("commit"))).toBeUndefined();
  });

  it("propagates commit failure and skips push", async () => {
    vi.spyOn(gitMod, "runGit").mockImplementation(async (args: string[]) => {
      invocations.push(args);
      if (args.includes("commit")) return err("commit boom");
      return ok();
    });
    const result = await commitFiles({ message: "m", branch: "feat" });
    expect(isFailure(result)).toBe(true);
    expect(invocations.find((c) => c[0] === "push")).toBeUndefined();
  });

  it("propagates push failure", async () => {
    vi.spyOn(gitMod, "runGit").mockImplementation(async (args: string[]) => {
      invocations.push(args);
      if (args[0] === "push") return err("push rejected");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("newsha\n");
      return ok();
    });
    const result = await commitFiles({ message: "m", branch: "feat" });
    expect(isFailure(result)).toBe(true);
  });

  it("propagates rev-parse HEAD failure", async () => {
    vi.spyOn(gitMod, "runGit").mockImplementation(async (args: string[]) => {
      invocations.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return err("rev-parse boom");
      return ok();
    });
    const result = await commitFiles({ message: "m", push: false });
    expect(isFailure(result)).toBe(true);
  });
});
