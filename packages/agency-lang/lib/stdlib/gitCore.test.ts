import { describe, it, expect } from "vitest";
import {
  hardenPositional, assertBranchAllowed, GIT_HARDENING_FLAGS, scrubEnv,
  statusArgs, logArgs, diffArgs, showArgs, branchListArgs, remoteListArgs,
  blameArgs, stashListArgs, addArgs, commitArgs, checkoutArgs, switchArgs,
  branchCreateArgs, branchDeleteArgs, stashPushArgs, stashPopArgs, restoreArgs,
  changedFilePaths, type GitStatus,
} from "./gitCore.js";

describe("hardenPositional", () => {
  it("passes through a normal ref/path/branch", () => {
    expect(hardenPositional("HEAD~1", "ref")).toBe("HEAD~1");
    expect(hardenPositional("src/index.ts", "path")).toBe("src/index.ts");
    expect(hardenPositional("feature/x", "branch")).toBe("feature/x");
  });
  it("rejects a flag-shaped value (the injection vector)", () => {
    expect(() => hardenPositional("--output=/etc/x", "ref")).toThrow(/ref/);
    expect(() => hardenPositional("-O", "path")).toThrow(/path/);
  });
  it("rejects empty values", () => {
    expect(() => hardenPositional("", "branch")).toThrow(/branch/);
  });
});

describe("assertBranchAllowed", () => {
  it("no-ops when protectedBranches is empty", () => {
    expect(() => assertBranchAllowed("main", [])).not.toThrow();
  });
  it("rejects a protected branch", () => {
    expect(() => assertBranchAllowed("main", ["main", "master"])).toThrow(/protected/);
  });
  it("allows a non-protected branch", () => {
    expect(() => assertBranchAllowed("feature/x", ["main", "master"])).not.toThrow();
  });
});

describe("GIT_HARDENING_FLAGS", () => {
  it("is exactly the expected paired -c flags", () => {
    expect(GIT_HARDENING_FLAGS).toEqual([
      "-c", "core.pager=cat",
      "-c", "core.fsmonitor=false",
      "--no-optional-locks",
    ]);
  });
});

describe("scrubEnv", () => {
  it("drops code-execution AND repo-retargeting git env vars", () => {
    const dangerous = [
      // code execution / config injection
      "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_SSH_COMMAND", "GIT_SSH",
      "GIT_PROXY_COMMAND", "GIT_EXEC_PATH", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
      "GIT_ATTR_SOURCE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT",
      // repo / worktree retargeting
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES",
    ];
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const k of dangerous) {
      base[k] = "x";
    }
    const out = scrubEnv(base);
    expect(out.PATH).toBe("/usr/bin");
    for (const k of dangerous) {
      expect(out[k]).toBeUndefined();
    }
  });
  it("keeps lookalikes that must survive (boundary)", () => {
    const out = scrubEnv({ GIT_AUTHOR_NAME: "Amy", GIT_COMMITTER_EMAIL: "a@b.c", GITHUB_TOKEN: "t" });
    expect(out.GIT_AUTHOR_NAME).toBe("Amy"); // commit identity must survive
    expect(out.GIT_COMMITTER_EMAIL).toBe("a@b.c");
    expect(out.GITHUB_TOKEN).toBe("t");
  });
  it("does not mutate the input", () => {
    const base = { GIT_PAGER: "x" };
    scrubEnv(base);
    expect(base.GIT_PAGER).toBe("x");
  });
});

describe("argv builders — reads", () => {
  it("statusArgs", () => {
    expect(statusArgs()).toEqual(["status", "--porcelain=v2", "--branch", "-z"]);
  });
  it("branchListArgs / remoteListArgs / stashListArgs are fixed", () => {
    expect(branchListArgs()[0]).toBe("for-each-ref");
    expect(remoteListArgs()).toEqual(["remote", "-v"]);
    expect(stashListArgs()).toEqual(["stash", "list"]);
  });
  it("logArgs maps typed params and separates ref (after --end-of-options) and path (after --)", () => {
    const args = logArgs({ count: 5, oneline: true, path: "src/", ref: "HEAD~3", author: "amy" });
    expect(args[0]).toBe("log");
    expect(args).toContain("-n"); expect(args).toContain("5");
    expect(args).toContain("--author=amy");
    expect(args).toContain("--end-of-options");
    expect(args[args.length - 1]).toBe("src/");
    expect(args[args.length - 2]).toBe("--");
  });
  it("logArgs rejects a flag-shaped ref", () => {
    expect(() => logArgs({ count: 5, oneline: false, path: "", ref: "--output=x", author: "" })).toThrow();
  });
  it("diffArgs emits the patch and places -- immediately before the path", () => {
    const args = diffArgs({ ref: "HEAD", ref2: "", staged: false, path: "src/x.ts" });
    expect(args[0]).toBe("diff");
    expect(args).toContain("--patch");
    expect(args[args.indexOf("src/x.ts") - 1]).toBe("--");
  });
  it("diffArgs staged + two refs, in order after --end-of-options", () => {
    const args = diffArgs({ ref: "A", ref2: "B", staged: true, path: "" });
    expect(args).toContain("--staged");
    expect(args.indexOf("A")).toBeGreaterThan(args.indexOf("--end-of-options"));
    expect(args.indexOf("B")).toBeGreaterThan(args.indexOf("A"));
  });
  it("showArgs", () => {
    expect(showArgs({ ref: "HEAD" })).toEqual(["show", "--patch", "-M", "--end-of-options", "HEAD"]);
  });
  it("blameArgs uses --line-porcelain, hardens path/ref, no --end-of-options (git blame rejects it before --)", () => {
    expect(blameArgs({ path: "a.ts", ref: "" })).toEqual(["blame", "--line-porcelain", "--", "a.ts"]);
    expect(blameArgs({ path: "a.ts", ref: "HEAD" })).toEqual(["blame", "--line-porcelain", "HEAD", "--", "a.ts"]);
    expect(() => blameArgs({ path: "-x", ref: "" })).toThrow(/path/);
  });
});

describe("argv builders — writes", () => {
  it("addArgs forbids -A only when all=false", () => {
    expect(addArgs({ paths: ["a.ts"], all: false })).toEqual(["add", "--", "a.ts"]);
    expect(addArgs({ paths: [], all: true })).toEqual(["add", "-A"]);
    expect(() => addArgs({ paths: ["-x"], all: false })).toThrow(/path/);
  });
  it("commitArgs passes the message as the value of -m; rejects empty", () => {
    expect(commitArgs({ message: "--amend looking msg" })).toEqual(["commit", "-m", "--amend looking msg"]);
    expect(() => commitArgs({ message: "" })).toThrow(/empty/);
  });
  it("checkoutArgs / switchArgs", () => {
    expect(checkoutArgs({ target: "main", force: false })).toEqual(["checkout", "--end-of-options", "main"]);
    expect(checkoutArgs({ target: "main", force: true })).toEqual(["checkout", "--force", "--end-of-options", "main"]);
    expect(switchArgs({ branch: "x", create: false })).toEqual(["switch", "--end-of-options", "x"]);
    expect(switchArgs({ branch: "x", create: true })).toEqual(["switch", "-c", "--end-of-options", "x"]);
  });
  it("branchCreateArgs / branchDeleteArgs (force + protected)", () => {
    expect(branchCreateArgs({ branch: "x" })).toEqual(["branch", "--end-of-options", "x"]);
    expect(branchDeleteArgs({ branch: "x", force: false, protectedBranches: [] })).toEqual(["branch", "-d", "--end-of-options", "x"]);
    expect(branchDeleteArgs({ branch: "x", force: true, protectedBranches: [] })).toEqual(["branch", "-D", "--end-of-options", "x"]);
    expect(() => branchDeleteArgs({ branch: "main", force: true, protectedBranches: ["main"] })).toThrow(/protected/);
  });
  it("stashPushArgs / stashPopArgs / restoreArgs", () => {
    expect(stashPushArgs({ message: "" })).toEqual(["stash", "push"]);
    expect(stashPushArgs({ message: "wip" })).toEqual(["stash", "push", "-m", "wip"]);
    expect(stashPopArgs()).toEqual(["stash", "pop"]);
    expect(restoreArgs({ paths: ["a.ts"], staged: false })).toEqual(["restore", "--", "a.ts"]);
    expect(restoreArgs({ paths: ["a.ts"], staged: true })).toEqual(["restore", "--staged", "--", "a.ts"]);
    expect(() => restoreArgs({ paths: ["-x"], staged: false })).toThrow(/path/);
  });
});

describe("changedFilePaths", () => {
  const status = (entries: GitStatus["entries"]): GitStatus => ({
    branch: "main",
    upstream: "",
    ahead: 0,
    behind: 0,
    entries,
  });

  it("projects entries to their paths in order", () => {
    const s = status([
      { path: "a.agency", index: "M", worktree: "." },
      { path: "sub/b.py", index: "A", worktree: "." },
      { path: "c.agency", index: "?", worktree: "?" },
    ]);
    expect(changedFilePaths(s)).toEqual(["a.agency", "sub/b.py", "c.agency"]);
  });

  it("returns [] for a clean tree", () => {
    expect(changedFilePaths(status([]))).toEqual([]);
  });

  it("includes deleted paths (caller reads them fail-open)", () => {
    const s = status([{ path: "gone.agency", index: "D", worktree: "." }]);
    expect(changedFilePaths(s)).toEqual(["gone.agency"]);
  });
});
