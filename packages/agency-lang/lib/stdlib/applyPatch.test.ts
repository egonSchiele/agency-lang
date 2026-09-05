import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { _applyPatch, _patchFiles } from "./fs.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const patchFor = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;

describe("applyPatch with an approved file list", () => {
  it("names the real path of each touched file before the interrupt", () => {
    const files = _patchFiles(patchFor("some/dir/x.txt"));
    expect(files).toEqual([path.resolve(process.cwd(), "some/dir/x.txt")]);
  });

  it("refuses a link planted at an approved path", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".patch-test-"));
    try {
      const rel = path.relative(process.cwd(), path.join(dir, "target.txt"));
      const patch = patchFor(rel);
      const approved = _patchFiles(patch);
      fs.writeFileSync(path.join(dir, "elsewhere.txt"), "old\n");
      fs.symlinkSync(path.join(dir, "elsewhere.txt"), path.join(dir, "target.txt"));
      await expect(_applyPatch(patch, [], approved)).rejects.toThrow(/symlink/);
      expect(fs.readFileSync(path.join(dir, "elsewhere.txt"), "utf8")).toBe("old\n");
    } finally {
      expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
    }
  });

  it("rejects an approved list that does not match the patch", async () => {
    await expect(_applyPatch(patchFor("a.txt"), [], [])).rejects.toThrow(/approved file list/);
  });
});
