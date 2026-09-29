import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { approvedFilePath, approvedFileBytes } from "./approvedPath.js";

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

describe("approvedFileBytes", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "approved-")));
  });
  afterEach(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), tmp);
  });

  it("returns the bytes of a regular file", () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, "png bytes");
    expect(approvedFileBytes(file, 100).toString()).toBe("png bytes");
  });

  it("refuses a file over the limit before reading it", () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, "0123456789");
    expect(() => approvedFileBytes(file, 9)).toThrow(
      `${file} is 10 bytes; the most this reads is 9.`,
    );
  });

  it("refuses a symlink, a missing file, and a directory", () => {
    const target = path.join(tmp, "elsewhere.png");
    fs.writeFileSync(target, "x");
    fs.symlinkSync(target, path.join(tmp, "link.png"));
    expect(() => approvedFileBytes(path.join(tmp, "link.png"), 100)).toThrow();
    expect(() => approvedFileBytes(path.join(tmp, "gone.png"), 100)).toThrow(/no such file/);
    expect(() => approvedFileBytes(tmp, 100)).toThrow(/not a regular file/);
  });
});
