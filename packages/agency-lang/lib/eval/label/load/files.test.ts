import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveFileSelection } from "./discoverFiles.js";
import { loadFiles, type LoadFilesArgs } from "./files.js";
import { DEFAULT_MAX_INGEST_BYTES } from "./types.js";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-files-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, contents: string): void {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function load(over: Partial<LoadFilesArgs> = {}) {
  return loadFiles({
    selection: resolveFileSelection(root, false),
    source: "handwritten",
    constantFields: {},
    maxBytes: DEFAULT_MAX_INGEST_BYTES,
    ...over,
  });
}

describe("loadFiles", () => {
  it("makes each file's whole contents one record's output field", () => {
    write("a.txt", "first answer");
    write("b.txt", "second answer");
    expect(load().occurrences.map((o) => o.fields.output)).toEqual([
      "first answer",
      "second answer",
    ]);
  });

  it("preserves internal newlines, because a file is one whole output", () => {
    // Label Studio and Prodigy both read a text file line by line. This is the
    // behaviour that differs, so it is pinned.
    write("a.txt", "line one\nline two\n");
    expect(load().occurrences[0].fields.output).toBe("line one\nline two\n");
    expect(load().occurrences).toHaveLength(1);
  });

  it("walks in sorted order so ingest is deterministic", () => {
    write("c.txt", "c");
    write("a.txt", "a");
    write("b.txt", "b");
    expect(load().occurrences.map((o) => o.fields.output)).toEqual(["a", "b", "c"]);
  });

  it("keys each occurrence by its path relative to the root", () => {
    write("a.txt", "same text");
    write("b.txt", "same text");
    const keys = load().occurrences.map((o) => (o.origin.kind === "file" ? o.origin.itemKey : "?"));
    expect(keys).toEqual(["a.txt", "b.txt"]);
  });

  it("merges constant fields into every record", () => {
    write("a.txt", "answer");
    expect(load({ constantFields: { task: "Summarize" } }).occurrences[0].fields).toEqual({
      task: "Summarize",
      output: "answer",
    });
  });

  it("skips an empty file with a reason", () => {
    write("a.txt", "   \n");
    write("b.txt", "real");
    const batch = load();
    expect(batch.occurrences).toHaveLength(1);
    expect(batch.skips).toEqual([{ item: "a.txt", reason: "empty" }]);
  });

  it("skips a file over the cap", () => {
    write("a.txt", "x".repeat(50));
    expect(load({ maxBytes: 10 }).skips).toEqual([{ item: "a.txt", reason: "too-large" }]);
  });

  it("skips a file that is not valid UTF-8 rather than storing replacement characters", () => {
    fs.writeFileSync(path.join(root, "a.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    expect(load().skips).toEqual([{ item: "a.bin", reason: "not-utf8" }]);
  });

  it("skips a symlink, which would make the item key ambiguous", () => {
    write("real.txt", "answer");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const batch = load();
    expect(batch.occurrences).toHaveLength(1);
    expect(batch.skips).toEqual([{ item: "link.txt", reason: "symlink" }]);
  });

  it("reads nested files when the selection is recursive", () => {
    write("nested/a.txt", "nested answer");
    write("top.txt", "top answer");
    const batch = load({ selection: resolveFileSelection(root, true) });
    expect(batch.occurrences).toHaveLength(2);
  });
});
