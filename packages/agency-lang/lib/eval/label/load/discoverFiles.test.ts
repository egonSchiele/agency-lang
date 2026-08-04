import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  looksLikeGlob,
  normalizePatternSeparators,
  resolveFileSelection,
  rootPrefixOf,
  splitPattern,
} from "./discoverFiles.js";
import { IngestSourceError } from "./types.js";

let root: string;

beforeEach(() => {
  // realpathSync because macOS resolves /var to /private/var, and the itemKeys
  // are computed from a resolved root.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-discover-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, contents = "x"): void {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function keys(source: string, recursive = false): string[] {
  return resolveFileSelection(source, recursive).files.map((file) => file.itemKey);
}

describe("looksLikeGlob", () => {
  it("recognises the supported metacharacters", () => {
    expect(looksLikeGlob("a/*.txt")).toBe(true);
    expect(looksLikeGlob("a/?.txt")).toBe(true);
    expect(looksLikeGlob("a/[ab].txt")).toBe(true);
  });

  it("treats an ordinary path as not a glob", () => {
    expect(looksLikeGlob("answers/gold")).toBe(false);
  });
});

describe("resolveFileSelection on a directory", () => {
  it("lists files sorted, so ingest is deterministic", () => {
    write("c.txt");
    write("a.txt");
    write("b.txt");
    expect(keys(root)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("ignores subdirectories unless recursive", () => {
    write("top.txt");
    write("nested/deep.txt");
    expect(keys(root)).toEqual(["top.txt"]);
    expect(keys(root, true).slice().sort()).toEqual(["nested/deep.txt", "top.txt"]);
  });

  it("uses the directory itself as the root, so keys are relative to it", () => {
    write("nested/deep.txt");
    const selection = resolveFileSelection(root, true);
    expect(selection.root).toBe(root);
    expect(selection.files[0].itemKey).toBe("nested/deep.txt");
  });

  it("carries a symlink through as a candidate, for the loader to skip", () => {
    write("real.txt");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const selection = resolveFileSelection(root, false);
    expect(selection.files.find((file) => file.itemKey === "link.txt")?.isSymlink).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    expect(() => resolveFileSelection(path.join(root, "nope"), false))
      .toThrow(IngestSourceError);
  });

  it("rejects a plain file, naming the shapes it does accept", () => {
    write("a.txt");
    expect(() => resolveFileSelection(path.join(root, "a.txt"), false))
      .toThrow(/quoted glob/);
  });
});

describe("resolveFileSelection on a glob", () => {
  it("matches within one directory", () => {
    write("a.txt");
    write("b.md");
    expect(keys(`${root}/*.txt`)).toEqual(["a.txt"]);
  });

  it("does not let * cross a directory boundary", () => {
    write("a.txt");
    write("nested/b.txt");
    expect(keys(`${root}/*.txt`, true)).toEqual(["a.txt"]);
  });

  it("descends for ** even when recursive was not asked for", () => {
    write("a.txt");
    write("nested/b.txt");
    expect(keys(`${root}/**/*.txt`).slice().sort()).toEqual(["a.txt", "nested/b.txt"]);
  });

  it("matches a single character with ?", () => {
    write("a.txt");
    write("ab.txt");
    expect(keys(`${root}/?.txt`)).toEqual(["a.txt"]);
  });

  it("matches a character class", () => {
    write("a.txt");
    write("b.txt");
    write("c.txt");
    expect(keys(`${root}/[ab].txt`)).toEqual(["a.txt", "b.txt"]);
  });

  it("roots keys at the deepest literal directory in the pattern", () => {
    write("nested/a.txt");
    const selection = resolveFileSelection(`${root}/nested/*.txt`, false);
    expect(selection.root).toBe(path.join(root, "nested"));
    expect(selection.files[0].itemKey).toBe("a.txt");
  });

  it("rejects a pattern that matches nothing, with a quoting hint", () => {
    write("a.md");
    expect(() => resolveFileSelection(`${root}/*.txt`, false)).toThrow(/quote the pattern/);
  });

  it("rejects a pattern whose literal prefix does not exist", () => {
    expect(() => resolveFileSelection(`${root}/missing/*.txt`, false))
      .toThrow(/does not exist/);
  });
});

describe("pattern separators on Windows", () => {
  // The separator is a parameter so these run anywhere. Without normalization a
  // pattern like C:\answers\*.txt stays one segment, resolves against the
  // current directory, and matches nothing.
  const WINDOWS = "\\";

  it("splits a drive-letter path on backslashes", () => {
    const split = splitPattern("C:\\answers\\*.txt", WINDOWS);
    expect(split.pattern).toBe("*.txt");
    expect(split.root.endsWith("answers")).toBe(true);
  });

  it("keeps a UNC prefix in the literal root", () => {
    const split = splitPattern("\\\\server\\share\\answers\\*.txt", WINDOWS);
    expect(split.pattern).toBe("*.txt");
    expect(split.root).toContain("answers");
  });

  it("handles a mixed-separator pattern, which shells do produce", () => {
    expect(splitPattern("C:\\answers/gold\\*.txt", WINDOWS).pattern).toBe("*.txt");
  });

  it("keeps ** working across backslashes", () => {
    expect(splitPattern("C:\\answers\\**\\*.txt", WINDOWS).pattern).toBe("**/*.txt");
  });

  it("leaves a backslash alone on POSIX, where it is a legal filename character", () => {
    const split = splitPattern("odd\\name/*.txt", "/");
    expect(split.pattern).toBe("*.txt");
    expect(split.root.endsWith("odd\\name")).toBe(true);
  });

  it("normalizes only when the platform separator says to", () => {
    expect(normalizePatternSeparators("a\\b", "/")).toBe("a\\b");
    expect(normalizePatternSeparators("a\\b", "\\")).toBe("a/b");
  });
});

describe("a pattern anchored at a filesystem root", () => {
  // `/*.txt` used to resolve to the working directory, silently reading a
  // different batch than the one named.
  it("keeps the POSIX root", () => {
    expect(splitPattern("/*.txt", "/")).toEqual({ root: "/", pattern: "*.txt" });
  });

  it("keeps a POSIX root with a literal directory under it", () => {
    expect(splitPattern("/answers/*.txt", "/")).toEqual({ root: "/answers", pattern: "*.txt" });
  });

  it("keeps a Windows drive root, which `C:` alone does not mean", () => {
    // path.resolve("C:") is that drive's CURRENT directory, not its root.
    expect(splitPattern("C:\\*.txt", "\\")).toEqual({ root: "C:\\", pattern: "*.txt" });
  });

  it("keeps a Windows drive root with a literal directory under it", () => {
    expect(splitPattern("C:\\answers\\*.txt", "\\"))
      .toEqual({ root: "C:\\answers", pattern: "*.txt" });
  });

  it("keeps a UNC root", () => {
    expect(splitPattern("\\\\server\\share\\*.txt", "\\"))
      .toEqual({ root: "\\\\server\\share\\", pattern: "*.txt" });
  });

  it("keeps a UNC root with a literal directory under it", () => {
    expect(splitPattern("\\\\server\\share\\answers\\*.txt", "\\"))
      .toEqual({ root: "\\\\server\\share\\answers", pattern: "*.txt" });
  });

  it("still resolves a relative pattern against the working directory", () => {
    const split = splitPattern("answers/*.txt", "/");
    expect(split.root).toBe(path.posix.resolve("answers"));
    expect(split.pattern).toBe("*.txt");
  });

  it("reports the root prefix it recognised", () => {
    expect(rootPrefixOf("/a/b")).toBe("/");
    expect(rootPrefixOf("C:/a")).toBe("C:/");
    expect(rootPrefixOf("//server/share/a")).toBe("//server/share/");
    expect(rootPrefixOf("answers/a")).toBe("");
  });
});
