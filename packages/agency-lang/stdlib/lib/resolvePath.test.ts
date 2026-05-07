import { describe, it, expect } from "vitest";
import { resolvePath } from "./fs.js";
import path from "path";

describe("resolvePath", () => {
  it("resolves filename relative to cwd when dir is empty", async () => {
    const result = await resolvePath("", "foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "foo.txt"));
  });

  it("joins dir and filename", async () => {
    const result = await resolvePath("src", "foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "foo.txt"));
  });

  it("handles nested subdirectory in filename", async () => {
    const result = await resolvePath("src", "sub/foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "sub/foo.txt"));
  });

  it("rejects absolute filename when dir is set", async () => {
    await expect(resolvePath("src", "/etc/passwd")).rejects.toThrow(
      "must not be absolute",
    );
  });

  it("rejects path traversal with ..", async () => {
    await expect(resolvePath("src", "../etc/passwd")).rejects.toThrow("escapes");
  });

  it("rejects deeper path traversal", async () => {
    await expect(resolvePath("src", "sub/../../etc/passwd")).rejects.toThrow("escapes");
  });

  it("allows .. that stays within dir", async () => {
    const result = await resolvePath("src", "sub/../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "foo.txt"));
  });

  it("does not restrict traversal when dir is empty", async () => {
    const result = await resolvePath("", "../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "../foo.txt"));
  });
});
