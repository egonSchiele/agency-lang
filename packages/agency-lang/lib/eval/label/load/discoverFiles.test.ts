import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveFileSelection } from "./discoverFiles.js";
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

describe("patterns are not supported", () => {
  it("rejects a path that is not a directory, naming what it does accept", () => {
    // A glob engine is a parser. This one grew a root-prefix rule, a Windows
    // separator rule and two bugs before it was removed.
    write("a.txt");
    expect(() => resolveFileSelection(`${root}/*.txt`, false)).toThrow(/Source not found/);
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
      .toThrow(/directory of files, a run directory, or a .json file/);
  });
});

