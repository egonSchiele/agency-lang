import { describe, it, expect } from "vitest";
import {
  hardenPositional, GIT_HARDENING_FLAGS, scrubEnv,
  statusArgs, logArgs, commitArgs,
  parseStatus, parseLog, FIELD_SEP as FS, RECORD_SEP as RS,
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
  it("drops every listed git command-injection var", () => {
    const out = scrubEnv({
      PATH: "/usr/bin",
      GIT_EXTERNAL_DIFF: "x", GIT_PAGER: "x", GIT_SSH_COMMAND: "x",
      GIT_SSH: "x", GIT_PROXY_COMMAND: "x", GIT_ALTERNATE_OBJECT_DIRECTORIES: "x",
      GIT_CONFIG_GLOBAL: "x", GIT_CONFIG_COUNT: "1",
    });
    expect(out.PATH).toBe("/usr/bin");
    for (const k of ["GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_SSH_COMMAND", "GIT_SSH",
      "GIT_PROXY_COMMAND", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT"]) {
      expect(out[k]).toBeUndefined();
    }
  });
  it("keeps lookalikes that must survive (boundary)", () => {
    const out = scrubEnv({ GIT_AUTHOR_NAME: "Amy", GITHUB_TOKEN: "t" });
    expect(out.GIT_AUTHOR_NAME).toBe("Amy"); // NOT stripped by a too-wide GIT* rule
    expect(out.GITHUB_TOKEN).toBe("t");
  });
  it("does not mutate the input", () => {
    const base = { GIT_PAGER: "x" };
    scrubEnv(base);
    expect(base.GIT_PAGER).toBe("x");
  });
});

describe("argv builders", () => {
  it("statusArgs", () => {
    expect(statusArgs()).toEqual(["status", "--porcelain=v2", "--branch", "-z"]);
  });
  it("logArgs maps typed params and separates ref (after --end-of-options) and path (after --)", () => {
    const a = logArgs({ n: 5, oneline: true, path: "src/", ref: "HEAD~3", author: "amy" });
    expect(a[0]).toBe("log");
    expect(a).toContain("-n"); expect(a).toContain("5");
    expect(a).toContain("--author=amy");
    expect(a).toContain("--end-of-options");
    expect(a[a.length - 1]).toBe("src/");
    expect(a[a.length - 2]).toBe("--");
  });
  it("logArgs rejects a flag-shaped ref", () => {
    expect(() => logArgs({ n: 5, oneline: false, path: "", ref: "--output=x", author: "" })).toThrow();
  });
  it("commitArgs passes the message as the value of -m; rejects empty", () => {
    expect(commitArgs({ message: "--amend looking msg" })).toEqual(["commit", "-m", "--amend looking msg"]);
    expect(() => commitArgs({ message: "" })).toThrow(/empty/);
  });
});

describe("parseStatus", () => {
  it("parses branch headers, modified/added, a space-in-path, a rename, an unmerged record, and untracked", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 hhh iii src/mod.ts",
      "1 A. N... 000000 100644 100644 000 jjj my file.ts",   // space in path
      "2 R. N... 100644 100644 100644 kkk lll R100 dst.ts",
      "old.ts",                                              // origPath NUL field
      "u UU N... 100644 100644 100644 100644 m1 m2 m3 conflict.ts",
      "? untracked.ts",
    ].join("\0") + "\0";
    const s = parseStatus(out);
    expect(s.branch).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.entries).toContainEqual({ path: "src/mod.ts", index: ".", worktree: "M" });
    expect(s.entries).toContainEqual({ path: "my file.ts", index: "A", worktree: "." });
    expect(s.entries).toContainEqual({ path: "dst.ts", index: "R", worktree: ".", renamedFrom: "old.ts" });
    expect(s.entries).toContainEqual({ path: "conflict.ts", index: "U", worktree: "U" });
    expect(s.entries).toContainEqual({ path: "untracked.ts", index: "?", worktree: "?" });
    expect(s.entries).toHaveLength(5);
  });
});

describe("parseLog", () => {
  it("parses commits with multi-line bodies; tolerates git's inter-record newline", () => {
    const rec = (f: string[]) => f.join(FS);
    const out =
      rec(["sha1", "Amy", "amy@x.com", "2026-01-01T00:00:00Z", "subj one", "body\nline2"]) + RS + "\n" +
      rec(["sha2", "Bob", "bob@x.com", "2026-01-02T00:00:00Z", "subj two", ""]) + RS + "\n";
    const log = parseLog(out);
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0]).toEqual({
      sha: "sha1", author: "Amy", email: "amy@x.com",
      date: "2026-01-01T00:00:00Z", subject: "subj one", body: "body\nline2",
    });
    expect(log.commits[1].body).toBe("");
  });
  it("returns no commits for empty output", () => {
    expect(parseLog("").commits).toEqual([]);
  });
});
