import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import {
  ignoresWholeDirectory,
  isIgnored,
  parseGitignore,
  repositoryAncestors,
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

describe("ignoresWholeDirectory", () => {
  const rules = (text: string) => [parseGitignore(root, text)];

  it("is true for a folder a rule names, and for one inside it", () => {
    expect(ignoresWholeDirectory(at("dist"), rules("dist/\n"))).toBe(true);
    expect(ignoresWholeDirectory(at("dist/lib"), rules("dist/\n"))).toBe(true);
    expect(ignoresWholeDirectory(at("src"), rules("dist/\n"))).toBe(false);
  });

  it("is true when the rules ignore everything inside a folder but not the folder", () => {
    expect(ignoresWholeDirectory(at("node_modules"), rules("**/node_modules/*\n"))).toBe(true);
    expect(ignoresWholeDirectory(at("src"), rules("src/*\n"))).toBe(true);
  });

  it("is true for a dot folder under a .* rule", () => {
    expect(ignoresWholeDirectory(at(".worktrees"), rules(".*\n"))).toBe(true);
  });

  it("is false when the rules ignore only some entries", () => {
    expect(ignoresWholeDirectory(at("src"), rules(".*\n*.log\n**/*.js\n"))).toBe(false);
  });

  it("is false for a folder an allow-list .gitignore keeps", () => {
    // `*` ignores every file, and `!*/` un-ignores every folder so git can
    // look inside. The made-up file is ignored and the made-up folder is not.
    expect(ignoresWholeDirectory(at("src"), rules("*\n!*/\n!*.ts\n"))).toBe(false);
  });

  it("is false with no files", () => {
    expect(ignoresWholeDirectory(at("dist"), [])).toBe(false);
  });
});

describe("repositoryAncestors", () => {
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

  it("lists the folders between a subdirectory and its repository root, outermost first", async () => {
    const outer = repo();
    mkdirSync(join(outer, ".git"));
    mkdirSync(join(outer, "lib", "deep"), { recursive: true });
    expect(await repositoryAncestors(host, join(outer, "lib", "deep"))).toEqual([
      outer,
      join(outer, "lib"),
    ]);
  });

  it("stops at a nested repository root, where an enclosing repository's rules do not reach", async () => {
    const outer = repo();
    mkdirSync(join(outer, ".git"));
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    mkdirSync(join(inner, "src"));
    expect(await repositoryAncestors(host, inner)).toEqual([]);
    expect(await repositoryAncestors(host, join(inner, "src"))).toEqual([inner]);
  });

  it("is null outside any repository", async () => {
    expect(await repositoryAncestors(host, repo())).toBeNull();
  });
});
