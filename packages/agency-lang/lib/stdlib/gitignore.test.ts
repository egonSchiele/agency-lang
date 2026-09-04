import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { isIgnored, parseGitignore, readAncestorGitignores } from "./gitignore.js";

const root = "/repo";
const at = (relative: string) => `${root}/${relative}`;

describe("parseGitignore + isIgnored", () => {
  it("an unanchored pattern matches at any depth", () => {
    const file = parseGitignore(root, "*.js\n");
    expect(isIgnored(at("a.js"), false, [file])).toBe(true);
    expect(isIgnored(at("lib/deep/a.js"), false, [file])).toBe(true);
    expect(isIgnored(at("lib/a.ts"), false, [file])).toBe(false);
  });

  it("a pattern with a slash is anchored to the .gitignore's directory", () => {
    const file = parseGitignore(root, "/build\nlib/gen\n");
    expect(isIgnored(at("build"), true, [file])).toBe(true);
    expect(isIgnored(at("sub/build"), true, [file])).toBe(false);
    expect(isIgnored(at("lib/gen"), true, [file])).toBe(true);
    expect(isIgnored(at("other/lib/gen"), true, [file])).toBe(false);
  });

  it("a trailing slash names directories only, but covers the files under one", () => {
    const file = parseGitignore(root, "out/\n");
    expect(isIgnored(at("out"), true, [file])).toBe(true);
    expect(isIgnored(at("out"), false, [file])).toBe(false);
    expect(isIgnored(at("out/x.txt"), false, [file])).toBe(true);
  });

  it("the last matching rule wins, so a negation un-ignores", () => {
    const file = parseGitignore(root, "*.log\n!keep.log\n");
    expect(isIgnored(at("a.log"), false, [file])).toBe(true);
    expect(isIgnored(at("keep.log"), false, [file])).toBe(false);
  });

  it("comments and blank lines are skipped", () => {
    const file = parseGitignore(root, "# generated\n\n*.js\n");
    expect(file.rules.length).toBe(1);
  });

  it("a nested .gitignore refines its parent and only speaks for its own subtree", () => {
    const parent = parseGitignore(root, "*.js\n");
    const child = parseGitignore(at("keep"), "!*.js\n");
    expect(isIgnored(at("keep/a.js"), false, [parent, child])).toBe(false);
    expect(isIgnored(at("other/a.js"), false, [parent, child])).toBe(true);
  });

  it("a name that starts with two dots is inside the directory, not above it", () => {
    const file = parseGitignore(root, "*.log\n");
    expect(isIgnored(at("..cache/a.log"), false, [file])).toBe(true);
    expect(isIgnored("/elsewhere/a.log", false, [file])).toBe(false);
  });

  it("braces and extglob are literal, as in git", () => {
    const file = parseGitignore(root, "*.{js,ts}\n+(a|b).log\n");
    expect(isIgnored(at("x.js"), false, [file])).toBe(false);
    expect(isIgnored(at("x.{js,ts}"), false, [file])).toBe(true);
    expect(isIgnored(at("a.log"), false, [file])).toBe(false);
    expect(isIgnored(at("+(a|b).log"), false, [file])).toBe(true);
  });

  it("dotfiles match like any other name", () => {
    const file = parseGitignore(root, ".env\n");
    expect(isIgnored(at(".env"), false, [file])).toBe(true);
    expect(isIgnored(at("config/.env"), false, [file])).toBe(true);
  });

  it("a [!x] bracket class negates the class, as in git", () => {
    const file = parseGitignore(root, "[!a]*.txt\n");
    expect(isIgnored(at("b.txt"), false, [file])).toBe(true);
    expect(isIgnored(at("a.txt"), false, [file])).toBe(false);
  });
});

describe("readAncestorGitignores", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) safeDeleteDirectoryWithin(tmpdir(), dir);
  });

  function repo(): string {
    const base = mkdtempSync(join(tmpdir(), "gitignore-"));
    scratchDirs.push(base);
    return base;
  }

  it("loads the files between a subdirectory and its repository root", async () => {
    const outer = repo();
    mkdirSync(join(outer, ".git"));
    writeFileSync(join(outer, ".gitignore"), "*.log\n");
    mkdirSync(join(outer, "lib", "deep"), { recursive: true });
    const files = await readAncestorGitignores(join(outer, "lib", "deep"));
    expect(files.map((file) => file.dir)).toEqual([outer]);
  });

  it("stops at a nested repository root, where an enclosing repository's rules do not reach", async () => {
    const outer = repo();
    mkdirSync(join(outer, ".git"));
    writeFileSync(join(outer, ".gitignore"), "*\n");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    mkdirSync(join(inner, "src"));
    expect(await readAncestorGitignores(inner)).toEqual([]);
    const fromSrc = await readAncestorGitignores(join(inner, "src"));
    expect(fromSrc.map((file) => file.dir)).toEqual([]);
  });

  it("finds nothing outside any repository", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    expect(await readAncestorGitignores(join(dir))).toEqual([]);
  });
});
