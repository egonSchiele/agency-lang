import { describe, it, expect } from "vitest";
import { resolvePath } from "./resolvePath.js";
import { agencyStore } from "../runtime/asyncContext.js";
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

  it("allows traversal with '.' since it resolves to cwd", async () => {
    // "../foo.txt" relative to "." escapes cwd, so this should throw
    await expect(resolvePath(".", "../foo.txt")).rejects.toThrow("escapes");
  });
});

describe("resolvePath with ALS moduleDir", () => {
  it("resolves relative dir against moduleDir from ALS frame", async () => {
    const result = await agencyStore.run(
      {
        ctx: {} as any,
        stack: {} as any,
        threads: {} as any,
        moduleDir: "/some/module/dir",
      },
      () => resolvePath("./prompts", "system.md"),
    );
    expect(result).toBe(path.resolve("/some/module/dir", "prompts", "system.md"));
  });

  it("absolute dir ignores moduleDir", async () => {
    const result = await agencyStore.run(
      {
        ctx: {} as any,
        stack: {} as any,
        threads: {} as any,
        moduleDir: "/some/module/dir",
      },
      () => resolvePath("/tmp", "foo.txt"),
    );
    expect(result).toBe(path.resolve("/tmp", "foo.txt"));
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

  it("still rejects absolute filename when dir starts with ~", async () => {
    await expect(resolvePath("~/notes", "/etc/passwd")).rejects.toThrow(
      "must not be absolute",
    );
  });

  it("rejects ~-prefixed filename", async () => {
    await expect(resolvePath(".", "~/foo")).rejects.toThrow(
      "must not be absolute",
    );
  });

  it("rejects .. traversal under ~/...", async () => {
    await expect(resolvePath("~/notes", "../escape")).rejects.toThrow(
      "escapes directory",
    );
  });
});
