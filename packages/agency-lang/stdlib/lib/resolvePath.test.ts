import { describe, it, expect } from "vitest";
import { resolvePath } from "./fs.js";
import path from "path";

describe("resolvePath", () => {
  it("resolves filename relative to cwd when dir is empty", () => {
    const result = resolvePath("", "foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "foo.txt"));
  });

  it("joins dir and filename", () => {
    const result = resolvePath("src", "foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "foo.txt"));
  });

  it("handles nested subdirectory in filename", () => {
    const result = resolvePath("src", "sub/foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "sub/foo.txt"));
  });

  it("rejects absolute filename when dir is set", () => {
    expect(() => resolvePath("src", "/etc/passwd")).toThrow(
      "must not be absolute",
    );
  });

  it("rejects path traversal with ..", () => {
    expect(() => resolvePath("src", "../etc/passwd")).toThrow("escapes");
  });

  it("rejects deeper path traversal", () => {
    expect(() => resolvePath("src", "sub/../../etc/passwd")).toThrow("escapes");
  });

  it("allows .. that stays within dir", () => {
    const result = resolvePath("src", "sub/../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "foo.txt"));
  });

  it("does not restrict traversal when dir is empty", () => {
    const result = resolvePath("", "../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "../foo.txt"));
  });
});
