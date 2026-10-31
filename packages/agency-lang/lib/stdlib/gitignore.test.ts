import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import {
  ignoredFromAbove,
  isIgnored,
  parseGitignore,
  readAncestorGitignores,
} from "./gitignore.js";
import { nodeHost } from "../host/node/nodeHost.js";

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
  const host = nodeHost();
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
    const files = await readAncestorGitignores(host, join(outer, "lib", "deep"));
    expect(files.map((file) => file.dir)).toEqual([outer]);
  });

  it("stops at a nested repository root, where an enclosing repository's rules do not reach", async () => {
    const outer = repo();
    mkdirSync(join(outer, ".git"));
    writeFileSync(join(outer, ".gitignore"), "*\n");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    mkdirSync(join(inner, "src"));
    expect(await readAncestorGitignores(host, inner)).toEqual([]);
    const fromSrc = await readAncestorGitignores(host, join(inner, "src"));
    expect(fromSrc.map((file) => file.dir)).toEqual([]);
  });

  it("finds nothing outside any repository", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    expect(await readAncestorGitignores(host, join(dir))).toEqual([]);
  });
});

describe("ignoredFromAbove", () => {
  const host = nodeHost();
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) safeDeleteDirectoryWithin(tmpdir(), dir);
  });

  /** A repository whose root .gitignore holds `rules`, with `paths` created
   *  under it (a trailing slash makes a directory). */
  function repoWith(rules: string, paths: string[]): string {
    const base = mkdtempSync(join(tmpdir(), "ignored-from-above-"));
    scratchDirs.push(base);
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".gitignore"), rules);
    for (const entry of paths) {
      if (entry.endsWith("/")) {
        mkdirSync(join(base, entry), { recursive: true });
      } else {
        mkdirSync(join(base, entry, ".."), { recursive: true });
        writeFileSync(join(base, entry), "x\n");
      }
    }
    return base;
  }

  it("is true for a directory the rules name, and for one inside it", async () => {
    const base = repoWith("dist/\n", ["dist/lib/a.js", "src/a.ts"]);
    expect(await ignoredFromAbove(host, join(base, "dist"))).toBe(true);
    expect(await ignoredFromAbove(host, join(base, "dist", "lib"))).toBe(true);
    expect(await ignoredFromAbove(host, join(base, "src"))).toBe(false);
  });

  it("is true when the rules ignore everything inside a directory but not the directory itself", async () => {
    const base = repoWith("**/node_modules/*\n", ["node_modules/pkg/index.js"]);
    expect(await ignoredFromAbove(host, join(base, "node_modules"))).toBe(true);
  });

  it("is true for a directory a bare star ignores", async () => {
    const base = repoWith("src/*\n", ["src/a.ts"]);
    expect(await ignoredFromAbove(host, join(base, "src"))).toBe(true);
  });

  it("is false when the rules ignore only some entries, since the search still finds the rest", async () => {
    const base = repoWith(".*\n*.log\n**/*.js\n", [
      "src/a.ts",
      "src/b.log",
      "src/.DS_Store",
      "src/c.js",
    ]);
    expect(await ignoredFromAbove(host, join(base, "src"))).toBe(false);
  });

  it("is false at the repository root, whose own .gitignore is the walk's to apply", async () => {
    const base = repoWith("*.log\n", ["a.log"]);
    expect(await ignoredFromAbove(host, base)).toBe(false);
  });

  it("is false outside any repository", async () => {
    const base = mkdtempSync(join(tmpdir(), "ignored-from-above-"));
    scratchDirs.push(base);
    writeFileSync(join(base, ".gitignore"), "*\n");
    mkdirSync(join(base, "sub"));
    expect(await ignoredFromAbove(host, join(base, "sub"))).toBe(false);
  });
});
