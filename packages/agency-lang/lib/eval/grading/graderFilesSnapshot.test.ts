import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, test } from "vitest";

import { snapshotGraderFiles } from "./graderFilesSnapshot.js";

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grader-files-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("snapshotGraderFiles", () => {
  test("stores the whole tree under one hash-named directory, keeping relative names", () => {
    const dir = tree({ "notes.md": "lead with the why", "sub/cleaned.md": "short" });
    const snap = snapshotGraderFiles(dir);
    expect(snap.dirName).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.files).toEqual([
      { name: `${snap.dirName}/notes.md`, content: "lead with the why" },
      { name: `${snap.dirName}/sub/cleaned.md`, content: "short" },
    ]);
  });

  test("the name depends on every path and every content", () => {
    const base = snapshotGraderFiles(tree({ "notes.md": "a" })).dirName;
    expect(snapshotGraderFiles(tree({ "notes.md": "a" })).dirName).toBe(base);
    expect(snapshotGraderFiles(tree({ "notes.md": "b" })).dirName).not.toBe(base);
    expect(snapshotGraderFiles(tree({ "other.md": "a" })).dirName).not.toBe(base);
  });

  test("refuses a symlink rather than storing what it pointed at", () => {
    const dir = tree({ "notes.md": "a" });
    fs.symlinkSync(path.join(dir, "notes.md"), path.join(dir, "link.md"));
    expect(() => snapshotGraderFiles(dir)).toThrow(/must not contain symlinks.*link\.md/);
  });
});
