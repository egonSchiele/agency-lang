import { describe, it, expect } from "vitest";
import { resolvePath } from "./resolvePath.js";
import path from "path";
import os from "node:os";

describe("resolvePath", () => {
  it("rejects empty dir", async () => {
    await expect(resolvePath("", "foo.txt")).rejects.toThrow("must not be empty");
  });

  it("resolves '.' as cwd", async () => {
    const result = await resolvePath(".", "foo.txt");
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

  it("lets an absolute filename win over dir", async () => {
    const result = await resolvePath("src", "/tmp/foo.txt");
    expect(result).toBe(path.resolve("/tmp/foo.txt"));
  });

  it("allows upward traversal with ..", async () => {
    const result = await resolvePath("src", "../other/foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "other", "foo.txt"));
  });

  it("allows deeper upward traversal", async () => {
    const result = await resolvePath("src", "sub/../../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "foo.txt"));
  });

  it("allows .. that stays within dir", async () => {
    const result = await resolvePath("src", "sub/../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "src", "foo.txt"));
  });

  it("allows traversal above cwd", async () => {
    const result = await resolvePath(".", "../foo.txt");
    expect(result).toBe(path.resolve(process.cwd(), "..", "foo.txt"));
  });
});

describe("resolvePath ~ expansion", () => {
  it("expands ~ in dir", async () => {
    const result = await resolvePath("~", "x.md");
    expect(result).toBe(path.join(os.homedir(), "x.md"));
  });

  it("expands ~/foo in dir", async () => {
    const result = await resolvePath("~/notes", "x.md");
    expect(result).toBe(path.join(os.homedir(), "notes", "x.md"));
  });

  it("expands ~-prefixed filename", async () => {
    const result = await resolvePath(".", "~/foo");
    expect(result).toBe(path.join(os.homedir(), "foo"));
  });

  it("allows .. traversal under ~/...", async () => {
    const result = await resolvePath("~/notes", "../escape");
    expect(result).toBe(path.join(os.homedir(), "escape"));
  });
});
