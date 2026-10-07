import { describe, expect, it } from "vitest";
import nodePath from "./path.node.js";
import portablePath from "./path.portable.js";

// Both files behind `#path` must match its declaration in packageImports.d.ts.
const nodeMatchesDeclaration: typeof import("#path").default = nodePath;
const portableMatchesDeclaration: typeof import("#path").default = portablePath;
void nodeMatchesDeclaration;
void portableMatchesDeclaration;

// The containment checks are built on `resolve` and `relative`, so a
// difference between the two modules is how a containment bug happens. The
// inputs are the ones the containment tests use: a root, a path inside it,
// a sibling that shares a prefix, a climb out, the root itself, and `/`.
// Node's `path` is POSIX on macOS and Linux, where this runs; on Windows
// the two modules are different by design.
const CWD = "/work/project";
const PATHS = [
  "/a/b",
  "/a/b/c",
  "/a/bc",
  "/x",
  "/",
  "/a/b/../c",
  "/a/b/./c/",
  "sub/name.txt",
  "../outside",
  "../x",
  "sub/../other",
  ".",
  "",
  "~/notes",
  "/a//b",
];

describe.skipIf(process.platform === "win32")("#path: Node and the portable module agree", () => {
  it("on resolve from the working directory", () => {
    for (const p of PATHS) {
      expect(portablePath.resolve(CWD, p), p).toBe(nodePath.resolve(CWD, p));
    }
  });

  it("on relative between every pair", () => {
    for (const from of PATHS) {
      for (const to of PATHS) {
        const a = nodePath.resolve(CWD, from);
        const b = nodePath.resolve(CWD, to);
        expect(portablePath.relative(a, b), `${from} -> ${to}`).toBe(nodePath.relative(a, b));
      }
    }
  });

  it("on join, normalize, dirname, basename, extname, isAbsolute, and parse", () => {
    for (const p of PATHS) {
      expect(portablePath.join(CWD, p, "leaf.txt"), p).toBe(nodePath.join(CWD, p, "leaf.txt"));
      expect(portablePath.normalize(p), p).toBe(nodePath.normalize(p));
      expect(portablePath.dirname(p), p).toBe(nodePath.dirname(p));
      expect(portablePath.basename(p), p).toBe(nodePath.basename(p));
      expect(portablePath.extname(p), p).toBe(nodePath.extname(p));
      expect(portablePath.isAbsolute(p), p).toBe(nodePath.isAbsolute(p));
      expect(portablePath.parse(p), p).toEqual(nodePath.parse(p));
    }
    expect(portablePath.sep).toBe(nodePath.sep);
    expect(portablePath.delimiter).toBe(nodePath.delimiter);
  });

  it("never reads process.cwd() when the first argument is absolute", () => {
    const original = process.cwd;
    let reads = 0;
    process.cwd = () => {
      reads += 1;
      return original();
    };
    try {
      portablePath.resolve(CWD, "sub/../other");
      portablePath.relative("/a/b", "/a/b/c");
      expect(reads).toBe(0);
    } finally {
      process.cwd = original;
    }
  });
});
