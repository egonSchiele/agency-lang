import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { realpath } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { prepareContainedPath, resolveRedirectTarget } from "./prepareContainedPath.js";

const sandboxes: string[] = [];

function sandbox(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "pcp-"));
  sandboxes.push(base);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const base of sandboxes.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

describe("prepareContainedPath", () => {
  it("accepts nested relative filenames and normalizes . and ..", async () => {
    const { root } = sandbox();
    expect(await prepareContainedPath(root, "src/lib/file.ts", "write")).toEqual({
      dir: await realDir(root),
      filename: path.join("src", "lib", "file.ts"),
    });
    expect((await prepareContainedPath(root, "a/./b/../c.txt", "write")).filename).toBe(
      path.join("a", "c.txt"),
    );
  });

  it("rejects absolute, ~, and escaping filenames with the teaching message", async () => {
    const { root, outside } = sandbox();
    const absolute = path.join(path.parse(root).root, "pcp-absolute-outside");
    await expect(prepareContainedPath(root, absolute, "write")).rejects.toThrow(
      /pass that directory in dir/,
    );
    await expect(prepareContainedPath(root, "~/payload.agency", "write")).rejects.toThrow(
      /pass that directory in dir/,
    );
    await expect(
      prepareContainedPath(root, path.join("..", path.basename(outside), "x"), "write"),
    ).rejects.toThrow(/pass that directory in dir/);
  });

  it("phrases the teaching sentence per operation", async () => {
    const { root } = sandbox();
    await expect(prepareContainedPath(root, "../x", "write")).rejects.toThrow(
      "To write somewhere else, pass that directory in dir.",
    );
    await expect(prepareContainedPath(root, "../x", "read")).rejects.toThrow(
      "To read from somewhere else, pass that directory in dir.",
    );
  });

  it("realpaths a symlinked dir", async () => {
    const { root } = sandbox();
    const link = path.join(path.dirname(root), "rootlink");
    symlinkSync(root, link);
    expect((await prepareContainedPath(link, "f.txt", "write")).dir).toBe(await realDir(root));
  });

  it("follows in-root symlinks and rejects escaping ones", async () => {
    const { root, outside } = sandbox();
    mkdirSync(path.join(root, "realsub"));
    symlinkSync(path.join(root, "realsub"), path.join(root, "insub"));
    symlinkSync(outside, path.join(root, "outsub"));
    // In-root parent link: allowed, filename keeps the link spelling.
    expect((await prepareContainedPath(root, "insub/f.txt", "write")).filename).toBe(
      path.join("insub", "f.txt"),
    );
    // Escaping parent link and escaping final link: rejected.
    await expect(prepareContainedPath(root, "outsub/f.txt", "write")).rejects.toThrow(
      /outside dir/,
    );
    writeFileSync(path.join(outside, "real.txt"), "x");
    symlinkSync(path.join(outside, "real.txt"), path.join(root, "leaflink"));
    await expect(prepareContainedPath(root, "leaflink", "write")).rejects.toThrow(/outside dir/);
    // In-root final link: allowed.
    writeFileSync(path.join(root, "inner.txt"), "x");
    symlinkSync(path.join(root, "inner.txt"), path.join(root, "innerlink"));
    expect((await prepareContainedPath(root, "innerlink", "write")).filename).toBe("innerlink");
  });

  it("follows a two-link in-root chain", async () => {
    const { root } = sandbox();
    writeFileSync(path.join(root, "end.txt"), "x");
    symlinkSync(path.join(root, "end.txt"), path.join(root, "hop2"));
    symlinkSync(path.join(root, "hop2"), path.join(root, "hop1"));
    expect((await prepareContainedPath(root, "hop1", "write")).filename).toBe("hop1");
  });

  it("rejects a symlink loop with ELOOP", async () => {
    const { root } = sandbox();
    symlinkSync(path.join(root, "loopB"), path.join(root, "loopA"));
    symlinkSync(path.join(root, "loopA"), path.join(root, "loopB"));
    await expect(prepareContainedPath(root, "loopA", "write")).rejects.toThrow(/ELOOP/);
  });

  it("rejects a regular file used as a directory with ENOTDIR", async () => {
    const { root } = sandbox();
    writeFileSync(path.join(root, "plain.txt"), "x");
    await expect(prepareContainedPath(root, "plain.txt/child", "write")).rejects.toThrow(/ENOTDIR/);
  });

  it("fails closed on a permission error instead of treating it as a lexical tail", async () => {
    const { root } = sandbox();
    const fsSync = await import("fs");
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    vi.spyOn(fsSync.default, "lstatSync").mockImplementationOnce(() => {
      throw denied;
    });
    await expect(prepareContainedPath(root, "secret/f.txt", "write")).rejects.toThrow(/EACCES/);
  });

  it("rejects dangling symlinks on the target path", async () => {
    const { root, outside } = sandbox();
    symlinkSync(path.join(outside, "missing"), path.join(root, "dangle"));
    await expect(prepareContainedPath(root, "dangle", "write")).rejects.toThrow(/dangling/);
    await expect(prepareContainedPath(root, "dangle/deeper.txt", "write")).rejects.toThrow(
      /dangling/,
    );
  });

  it("treats missing intermediate directories as contained, not dangling", async () => {
    const { root } = sandbox();
    expect((await prepareContainedPath(root, "sub/new/file.txt", "write")).filename).toBe(
      path.join("sub", "new", "file.txt"),
    );
  });

  it("requires dir to exist", async () => {
    const { root } = sandbox();
    await expect(prepareContainedPath(path.join(root, "nope"), "f.txt", "write")).rejects.toThrow();
  });

  it("rejects an empty dir instead of silently using cwd", async () => {
    await expect(prepareContainedPath("", "f.txt", "write")).rejects.toThrow(/dir/);
  });

  it.runIf(process.platform === "win32")("contains case-insensitively on Windows", async () => {
    const { root } = sandbox();
    const upper = root.toUpperCase();
    expect((await prepareContainedPath(upper, "f.txt", "write")).dir.toLowerCase()).toBe(
      (await realDir(root)).toLowerCase(),
    );
  });
});

async function realDir(p: string): Promise<string> {
  return realpath(p);
}

describe("resolveRedirectTarget", () => {
  it("splits absolute and relative targets into real parent + name", async () => {
    const { root, outside } = sandbox();
    expect(await resolveRedirectTarget(join2(outside, "out.txt"), root, "expand")).toEqual({
      dir: await realDir(outside),
      filename: "out.txt",
    });
    expect(await resolveRedirectTarget("sub/out.txt", root, "expand")).toEqual({
      dir: path.join(await realDir(root), "sub"),
      filename: "out.txt",
    });
  });

  it("expands or preserves ~ per tildeMode", async () => {
    const { root } = sandbox();
    const expanded = await resolveRedirectTarget("~/cf-rrt.txt", root, "expand");
    expect(expanded.dir.includes("~")).toBe(false);
    expect(expanded.filename).toBe("cf-rrt.txt");
    const literal = await resolveRedirectTarget("~/cf-rrt.txt", root, "literal");
    expect(literal.dir).toBe(path.join(await realDir(root), "~"));
  });

  it("resolves symlinked parents and existing final symlinks to real locations", async () => {
    const { root, outside } = sandbox();
    symlinkSync(outside, path.join(root, "plink"));
    expect(await resolveRedirectTarget("plink/out.txt", root, "expand")).toEqual({
      dir: await realDir(outside),
      filename: "out.txt",
    });
    writeFileSync(path.join(outside, "real.txt"), "x");
    symlinkSync(path.join(outside, "real.txt"), path.join(root, "flink"));
    expect(await resolveRedirectTarget("flink", root, "expand")).toEqual({
      dir: await realDir(outside),
      filename: "real.txt",
    });
  });

  it("follows a two-link chain and fails closed on loops and dangling links", async () => {
    const { root, outside } = sandbox();
    writeFileSync(path.join(outside, "end.txt"), "x");
    symlinkSync(path.join(outside, "end.txt"), path.join(root, "hop2"));
    symlinkSync(path.join(root, "hop2"), path.join(root, "hop1"));
    expect((await resolveRedirectTarget("hop1", root, "expand")).filename).toBe("end.txt");
    symlinkSync(path.join(root, "loopB"), path.join(root, "loopA"));
    symlinkSync(path.join(root, "loopA"), path.join(root, "loopB"));
    await expect(resolveRedirectTarget("loopA", root, "expand")).rejects.toThrow(/ELOOP/);
    symlinkSync(path.join(outside, "missing"), path.join(root, "dangle"));
    await expect(resolveRedirectTarget("dangle", root, "expand")).rejects.toThrow(/dangling/);
    await expect(resolveRedirectTarget("dangle/deep.txt", root, "expand")).rejects.toThrow(
      /dangling/,
    );
  });

  it("rejects an empty cwd", async () => {
    await expect(resolveRedirectTarget("f.txt", "", "expand")).rejects.toThrow(/cwd/);
  });
});

function join2(a: string, b: string): string {
  return path.join(a, b);
}
