import { describe, it, expect } from "vitest";
import {
  hardenPositional, GIT_HARDENING_FLAGS, scrubEnv,
  statusArgs, logArgs, commitArgs,
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
  it("commitArgs passes the message as the value of -m; rejects empty", () => {
    expect(commitArgs({ message: "--amend looking msg" })).toEqual(["commit", "-m", "--amend looking msg"]);
    expect(() => commitArgs({ message: "" })).toThrow(/empty/);
  });
});
