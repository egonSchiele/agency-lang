import { describe, it, expect } from "vitest";
import { isIgnored, parseGitignore } from "./gitignore.js";

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

  it("dotfiles match like any other name", () => {
    const file = parseGitignore(root, ".env\n");
    expect(isIgnored(at(".env"), false, [file])).toBe(true);
    expect(isIgnored(at("config/.env"), false, [file])).toBe(true);
  });
});
