import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approvedFilePath } from "./approvedPath.js";

describe("approvedFilePath", () => {
  let tmp: string;
  beforeEach(() => {
    // realpath: on macOS os.tmpdir() sits under /var, which is a symlink,
    // and fixedPath refuses a spelling with a link in it.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "approved-")));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the resolved path of a regular file", () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, "x");
    expect(approvedFilePath(file)).toBe(fs.realpathSync(file));
  });

  it("refuses a missing file", () => {
    expect(() => approvedFilePath(path.join(tmp, "gone.png"))).toThrow(/no such file/);
  });

  it("refuses a directory", () => {
    expect(() => approvedFilePath(tmp)).toThrow(/not a regular file/);
  });

  it("refuses a symlink that replaced the file after approval", () => {
    const target = path.join(tmp, "elsewhere.png");
    fs.writeFileSync(target, "x");
    const file = path.join(tmp, "a.png");
    fs.symlinkSync(target, file);
    expect(() => approvedFilePath(file)).toThrow();
  });

  it("refuses a directory in the spelling that became a symlink", () => {
    const realDir = path.join(tmp, "real");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "a.png"), "x");
    const linkDir = path.join(tmp, "link");
    fs.symlinkSync(realDir, linkDir);
    expect(() => approvedFilePath(path.join(linkDir, "a.png"))).toThrow();
  });
});
