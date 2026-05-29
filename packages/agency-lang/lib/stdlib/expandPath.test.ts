import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { expandPath } from "./expandPath.js";

describe("expandPath", () => {
  it("expands ~ alone to os.homedir()", () => {
    expect(expandPath("~")).toBe(os.homedir());
  });

  it("expands ~/foo to homedir/foo", () => {
    expect(expandPath("~/foo")).toBe(path.join(os.homedir(), "foo"));
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

  it("throws a clear error when os.homedir returns falsy", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("");
    try {
      expect(() => expandPath("~/foo")).toThrow(/HOME/i);
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
