import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as contained from "./contained.js";
import {
  root,
  fixedRoot,
  fixedPath,
  resolveUnder,
  wholePath,
  isContained,
  readText,
  readStream,
  readBytes,
  writeText,
  writeBytes,
  list,
  stat,
  mkdir,
  remove,
  copy,
  move,
  PRIMITIVES,
  HELPERS,
  type WriteMode,
} from "./contained.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

describe("root", () => {
  test("realpaths an existing directory", () => {
    const dir = makeDir(".ct-root-");
    try {
      expect(root(dir).real).toBe(fs.realpathSync(dir));
    } finally {
      cleanup(dir);
    }
  });

  test("follows a symlink in the caller's own spelling", () => {
    const base = makeDir(".ct-spelling-");
    try {
      fs.mkdirSync(path.join(base, "real"));
      fs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
      expect(root(path.join(base, "link")).real).toBe(fs.realpathSync(path.join(base, "real")));
    } finally {
      cleanup(base);
    }
  });

  test("a missing directory keeps a lexical tail under its nearest real ancestor", () => {
    const base = makeDir(".ct-missing-");
    try {
      const real = fs.realpathSync(base);
      expect(root(path.join(base, "not", "yet")).real).toBe(path.join(real, "not", "yet"));
    } finally {
      cleanup(base);
    }
  });

  test("a dangling symlink in the spelling is refused", () => {
    const base = makeDir(".ct-dangling-");
    try {
      fs.symlinkSync(path.join(base, "gone"), path.join(base, "dangle"));
      expect(() => root(path.join(base, "dangle"))).toThrow(/dangling/);
    } finally {
      cleanup(base);
    }
  });

  test("a symlink loop in the spelling is refused", () => {
    const base = makeDir(".ct-loop-");
    try {
      fs.symlinkSync(path.join(base, "b"), path.join(base, "a"));
      fs.symlinkSync(path.join(base, "a"), path.join(base, "b"));
      expect(() => root(path.join(base, "a"))).toThrow();
    } finally {
      cleanup(base);
    }
  });

  test("expands ~ and refuses an empty dir", () => {
    expect(root("~").real).toBe(fs.realpathSync(os.homedir()));
    expect(() => root("")).toThrow(/must not be empty/);
    expect(() => root("   ")).toThrow(/must not be empty/);
  });
});

describe("resolveUnder", () => {
  test("joins a relative target and normalizes ./", () => {
    const dir = makeDir(".ct-join-");
    try {
      const r = root(dir);
      expect(resolveUnder(r, "a/b.txt")).toBe(path.join(r.real, "a", "b.txt"));
      expect(resolveUnder(r, "./a/../a/b.txt")).toBe(path.join(r.real, "a", "b.txt"));
      expect(resolveUnder(r, ".")).toBe(r.real);
      expect(resolveUnder(r, "")).toBe(r.real);
    } finally {
      cleanup(dir);
    }
  });

  test("refuses an absolute path, a ~ path, and an upward escape", () => {
    const dir = makeDir(".ct-escape-");
    try {
      const r = root(dir);
      expect(() => resolveUnder(r, "/etc/passwd")).toThrow(/outside/);
      expect(() => resolveUnder(r, "~/x")).toThrow(/outside/);
      expect(() => resolveUnder(r, "../x")).toThrow(/outside/);
      expect(() => resolveUnder(r, "a/../../x")).toThrow(/outside/);
    } finally {
      cleanup(dir);
    }
  });

  test("refuses a symlink at any component below the root, even one pointing inside", () => {
    const dir = makeDir(".ct-below-");
    try {
      fs.mkdirSync(path.join(dir, "real"));
      fs.writeFileSync(path.join(dir, "real", "f.txt"), "x");
      fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
      fs.symlinkSync(path.join(dir, "real", "f.txt"), path.join(dir, "flink"));
      const r = root(dir);
      expect(() => resolveUnder(r, "link")).toThrow(/symlink/);
      expect(() => resolveUnder(r, "link/f.txt")).toThrow(/symlink/);
      expect(() => resolveUnder(r, "flink")).toThrow(/symlink/);
      expect(resolveUnder(r, "real/f.txt")).toBe(path.join(r.real, "real", "f.txt"));
    } finally {
      cleanup(dir);
    }
  });

  test("a target that does not exist yet resolves lexically", () => {
    const dir = makeDir(".ct-new-");
    try {
      const r = root(dir);
      expect(resolveUnder(r, "new/deep/file.txt")).toBe(
        path.join(r.real, "new", "deep", "file.txt"),
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("fixedRoot and fixedPath", () => {
  test("accepts a real spelling with a missing tail", () => {
    const dir = makeDir(".ct-fixed-");
    try {
      const real = fs.realpathSync(dir);
      expect(fixedRoot(real).real).toBe(real);
      expect(fixedRoot(path.join(real, "not", "yet")).real).toBe(path.join(real, "not", "yet"));
      const located = fixedPath(path.join(real, "child"));
      expect(located.root.real).toBe(real);
      expect(located.target).toBe("child");
    } finally {
      cleanup(dir);
    }
  });

  test("refuses a symlink anywhere in the spelling, where root would follow it", () => {
    const base = makeDir(".ct-fixedlink-");
    try {
      fs.mkdirSync(path.join(base, "real", "sub"), { recursive: true });
      fs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
      const linked = path.join(fs.realpathSync(base), "link");
      expect(root(linked).real).toBe(fs.realpathSync(path.join(base, "real")));
      expect(() => fixedRoot(linked)).toThrow(/symlink/);
      expect(() => fixedRoot(path.join(linked, "sub"))).toThrow(/symlink/);
      expect(() => fixedPath(path.join(linked, "sub"))).toThrow(/symlink/);
    } finally {
      cleanup(base);
    }
  });
});

describe("wholePath", () => {
  test("splits into the real parent and the final name", () => {
    const dir = makeDir(".ct-whole-");
    try {
      const located = wholePath(path.join(dir, "child"));
      expect(located.root.real).toBe(fs.realpathSync(dir));
      expect(located.target).toBe("child");
    } finally {
      cleanup(dir);
    }
  });
});

describe("isContained", () => {
  test("same path, descendant, and escape", () => {
    expect(isContained("/a/b", "/a/b")).toBe(true);
    expect(isContained("/a/b/c", "/a/b")).toBe(true);
    expect(isContained("/a/bc", "/a/b")).toBe(false);
    expect(isContained("/x", "/a/b")).toBe(false);
    expect(isContained("/a/b", "/")).toBe(true);
  });
});

describe("readText and readBytes", () => {
  test("read a regular file under the root", () => {
    const dir = makeDir(".ct-read-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", "a.txt"), "hello");
      const r = root(dir);
      expect(readText(r, "sub/a.txt")).toBe("hello");
      expect(readBytes(r, "sub/a.txt").toString("utf8")).toBe("hello");
    } finally {
      cleanup(dir);
    }
  });

  test("readStream yields the same bytes and closes its descriptor", async () => {
    const dir = makeDir(".ct-stream-");
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "hello");
      const stream = readStream(root(dir), "a.txt");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
      expect(stream.closed).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("reading the root itself is not a regular file", () => {
    const dir = makeDir(".ct-readdir-");
    try {
      expect(() => readText(root(dir), ".")).toThrow(/not a regular file/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("writeText modes", () => {
  test("overwrite replaces content and leaves no temporary file behind", () => {
    const dir = makeDir(".ct-over-");
    try {
      const r = root(dir);
      writeText(r, "f.txt", "one");
      writeText(r, "f.txt", "two", { mode: "overwrite" });
      expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("two");
      expect(fs.readdirSync(dir)).toEqual(["f.txt"]);
    } finally {
      cleanup(dir);
    }
  });

  test("overwrite preserves the existing file mode", () => {
    const dir = makeDir(".ct-mode-");
    try {
      const r = root(dir);
      writeText(r, "f.txt", "one", { fileMode: 0o600 });
      writeText(r, "f.txt", "two");
      expect(fs.statSync(path.join(dir, "f.txt")).mode & 0o777).toBe(0o600);
    } finally {
      cleanup(dir);
    }
  });

  test("append adds to an existing file and creates a missing one", () => {
    const dir = makeDir(".ct-append-");
    try {
      const r = root(dir);
      writeText(r, "f.txt", "a", { mode: "append" });
      writeText(r, "f.txt", "b", { mode: "append" });
      expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("ab");
    } finally {
      cleanup(dir);
    }
  });

  test("create-only refuses an existing file", () => {
    const dir = makeDir(".ct-create-");
    try {
      const r = root(dir);
      writeText(r, "f.txt", "a", { mode: "create-only" });
      expect(() => writeText(r, "f.txt", "b", { mode: "create-only" })).toThrow(/already exists/);
      expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("a");
    } finally {
      cleanup(dir);
    }
  });

  test("a write into a missing parent directory fails rather than creating it", () => {
    const dir = makeDir(".ct-noparent-");
    try {
      expect(() => writeText(root(dir), "missing/f.txt", "a")).toThrow();
      expect(fs.existsSync(path.join(dir, "missing"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("writeBytes writes raw bytes", () => {
    const dir = makeDir(".ct-bytes-");
    try {
      writeBytes(root(dir), "b.bin", Buffer.from([1, 2, 3]));
      expect([...fs.readFileSync(path.join(dir, "b.bin"))]).toEqual([1, 2, 3]);
    } finally {
      cleanup(dir);
    }
  });

  test("an unknown mode is refused", () => {
    const dir = makeDir(".ct-badmode-");
    try {
      expect(() => writeText(root(dir), "f.txt", "a", { mode: "bogus" as WriteMode })).toThrow(
        /Invalid mode/,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("list and stat", () => {
  test("list omits symlinked entries and reports type and size", () => {
    const dir = makeDir(".ct-list-");
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "abc");
      fs.mkdirSync(path.join(dir, "sub"));
      fs.symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link.txt"));
      const entries = list(root(dir), ".").sort((x, y) => x.name.localeCompare(y.name));
      expect(entries.map((entry) => [entry.name, entry.type])).toEqual([
        ["a.txt", "file"],
        ["sub", "dir"],
      ]);
      expect(entries[0].size).toBe(3);
    } finally {
      cleanup(dir);
    }
  });

  test("stat: a file, the root, a missing entry, and a symlink below the root", () => {
    const dir = makeDir(".ct-stat-");
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "abc");
      fs.symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link.txt"));
      const r = root(dir);
      expect(stat(r, "a.txt")?.isFile()).toBe(true);
      expect(stat(r, ".")?.isDirectory()).toBe(true);
      expect(stat(r, "nope")).toBeNull();
      expect(stat(r, "link.txt")).toBeNull();
    } finally {
      cleanup(dir);
    }
  });
});

describe("mkdir, remove, copy, move", () => {
  test("mkdir creates nested directories and is idempotent", () => {
    const dir = makeDir(".ct-mkdir-");
    try {
      const r = root(dir);
      mkdir(r, "a/b/c");
      mkdir(r, "a/b/c");
      expect(fs.statSync(path.join(dir, "a", "b", "c")).isDirectory()).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("remove deletes a tree and tolerates a missing target", () => {
    const dir = makeDir(".ct-remove-");
    try {
      const r = root(dir);
      mkdir(r, "t/inner");
      remove(r, "t");
      remove(r, "t");
      expect(fs.existsSync(path.join(dir, "t"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("copy copies a tree, keeping file modes", () => {
    const dir = makeDir(".ct-copy-");
    try {
      const r = root(dir);
      mkdir(r, "src/deep");
      fs.writeFileSync(path.join(dir, "src", "f.txt"), "x", { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "src", "deep", "g.txt"), "y");
      copy({ root: r, target: "src" }, { root: r, target: "dst" });
      expect(fs.readFileSync(path.join(dir, "dst", "f.txt"), "utf8")).toBe("x");
      expect(fs.readFileSync(path.join(dir, "dst", "deep", "g.txt"), "utf8")).toBe("y");
      expect(fs.statSync(path.join(dir, "dst", "f.txt")).mode & 0o777).toBe(0o600);
    } finally {
      cleanup(dir);
    }
  });

  test("copy refuses a destination inside or equal to the source", () => {
    const dir = makeDir(".ct-copyself-");
    try {
      const r = root(dir);
      mkdir(r, "src");
      fs.writeFileSync(path.join(dir, "src", "f.txt"), "x");
      expect(() => copy({ root: r, target: "src" }, { root: r, target: "src/backup" })).toThrow(
        /inside source/,
      );
      expect(() => copy({ root: r, target: "src" }, { root: r, target: "src" })).toThrow(
        /inside source/,
      );
      expect(fs.existsSync(path.join(dir, "src", "backup"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("copy refuses a tree that contains a link anywhere", () => {
    const dir = makeDir(".ct-copylink-");
    try {
      const r = root(dir);
      mkdir(r, "src/deep");
      fs.writeFileSync(path.join(dir, "src", "f.txt"), "x");
      fs.symlinkSync(path.join(dir, "src", "f.txt"), path.join(dir, "src", "deep", "l.txt"));
      expect(() => copy({ root: r, target: "src" }, { root: r, target: "dst" })).toThrow(/symlink/);
    } finally {
      cleanup(dir);
    }
  });

  test("move renames within one root", () => {
    const dir = makeDir(".ct-move-");
    try {
      const r = root(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "x");
      move({ root: r, target: "a.txt" }, { root: r, target: "b.txt" });
      expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("x");
    } finally {
      cleanup(dir);
    }
  });
});

describe("the registry", () => {
  test("every exported function is a primitive or a helper", () => {
    const exported = Object.entries(contained)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([...PRIMITIVES, ...HELPERS].sort());
  });
});
