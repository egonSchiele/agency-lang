import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { _grepSpill, _readSpill, _spillName, _spillOutput } from "./spill.js";

describe("spill", () => {
  const scratch: string[] = [];
  const savedEnv = process.env.AGENCY_TOOL_OUTPUT_DIR;

  function spillAt(dir: string): void {
    process.env.AGENCY_TOOL_OUTPUT_DIR = dir;
  }

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENCY_TOOL_OUTPUT_DIR;
    else process.env.AGENCY_TOOL_OUTPUT_DIR = savedEnv;
    for (const dir of scratch.splice(0)) safeDeleteDirectoryWithin(tmpdir(), dir);
  });

  function base(): string {
    const dir = mkdtempSync(join(tmpdir(), "spill-"));
    scratch.push(dir);
    return dir;
  }

  it("writes under the spill directory and reads the file back", async () => {
    const dir = join(base(), "out");
    spillAt(dir);
    const name = _spillName();
    await _spillOutput(name, "one\ntwo\nthree\n");
    expect(await _readSpill(name, 0, 0)).toBe("one\ntwo\nthree\n");
    expect(await _readSpill(name, 2, 1)).toContain("two");
    expect(await _grepSpill("t", name, 10)).toEqual([
      { file: name, line: 2, text: "two" },
      { file: name, line: 3, text: "three" },
    ]);
  });

  it("refuses a name that is not a saved file name", async () => {
    spillAt(join(base(), "out"));
    for (const bad of ["../x.log", "/etc/passwd", ".hidden.log", "notes.txt", "a/b.log"]) {
      await expect(_readSpill(bad, 0, 0)).rejects.toThrow("not a saved output file name");
    }
  });

  it("refuses a symlink where a saved file is expected", async () => {
    const root = base();
    const dir = join(root, "out");
    mkdirSync(dir);
    writeFileSync(join(root, "secret.txt"), "secret");
    symlinkSync(join(root, "secret.txt"), join(dir, "planted.log"));
    spillAt(dir);
    await expect(_readSpill("planted.log", 0, 0)).rejects.toThrow();
    await expect(_grepSpill("secret", "planted.log", 10)).rejects.toThrow();
  });

  it("refuses a spill directory that is a symlink", async () => {
    const root = base();
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "out"));
    spillAt(join(root, "out"));
    await expect(_spillOutput(_spillName(), "x")).rejects.toThrow("is a symlink");
  });
});
