import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { expandPath } from "./expandPath.js";

describe("expandPath", () => {
  it("expands ~ alone to os.homedir()", () => {
    expect(expandPath("~")).toBe(os.homedir());
  });

  it("expands ~/ (trailing slash only) to os.homedir()", () => {
    // Falls through to path.join(home, "") which normalizes to home.
    expect(expandPath("~/")).toBe(os.homedir());
  });

  it("expands ~/foo to homedir/foo", () => {
    expect(expandPath("~/foo")).toBe(path.join(os.homedir(), "foo"));
  });

  it("normalizes ~//foo (double separator) to homedir/foo", () => {
    // Guards against a regression if anyone swaps path.join for
    // path.resolve — path.resolve would treat /foo as absolute and
    // drop the home prefix entirely.
    expect(expandPath("~//foo")).toBe(path.join(os.homedir(), "foo"));
  });

  it("expands ~/nested/path", () => {
    expect(expandPath("~/.agency/memory")).toBe(
      path.join(os.homedir(), ".agency/memory"),
    );
  });

  it("returns input unchanged when there is no ~", () => {
    expect(expandPath("notilde")).toBe("notilde");
    expect(expandPath("./relative")).toBe("./relative");
    expect(expandPath("/etc/passwd")).toBe("/etc/passwd");
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandPath("/etc/~/foo")).toBe("/etc/~/foo");
    expect(expandPath("./sub/~user/x")).toBe("./sub/~user/x");
  });

  it("rejects ~user/foo with a clear message", () => {
    expect(() => expandPath("~user/foo")).toThrow(/~user/);
    expect(() => expandPath("~root")).toThrow(/~user/);
  });

  it("returns empty string unchanged", () => {
    expect(expandPath("")).toBe("");
  });

  it("returns undefined/null unchanged (sentinel passthrough)", () => {
    // Some call sites guard before invoking; these passthroughs exist
    // so a sentinel value reaches the next layer rather than crashing
    // inside expandPath itself.
    expect(expandPath(undefined as unknown as string)).toBe(undefined);
    expect(expandPath(null as unknown as string)).toBe(null);
  });

  it("throws a clear error when os.homedir returns falsy (~/foo form)", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("");
    try {
      expect(() => expandPath("~/foo")).toThrow(/HOME/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("throws the same error for `~` alone when homedir is missing", () => {
    // Guards against a regression where someone reorders the function
    // and the `if (p === "~") return home;` branch runs before the
    // empty-home check — in which case `expandPath("~")` would
    // silently return `""` instead of throwing.
    const spy = vi.spyOn(os, "homedir").mockReturnValue("");
    try {
      expect(() => expandPath("~")).toThrow(/HOME/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves Windows-style absolute paths unchanged", () => {
    expect(expandPath("C:\\Users\\Foo")).toBe("C:\\Users\\Foo");
  });

  it("treats backslash after ~ as a separator (Windows-style ~\\foo)", () => {
    // Cross-platform: even on POSIX we accept `\` after `~` as a
    // separator so a Windows-shaped path string from a config file
    // or stdin doesn't surprise users who copy-pasted across
    // platforms. The tail's joined via path.join, so on POSIX you
    // get `$HOME/foo` and on Windows `$HOME\foo`.
    expect(expandPath("~\\foo")).toBe(path.join(os.homedir(), "foo"));
  });
});
