import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { nodeHost } from "../host/nodeHost.js";
import { approvedFilePath, approvedFileBytes } from "./approvedPath.js";

const host = nodeHost();

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

  it("returns the resolved path of a regular file", async () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, "x");
    expect(await approvedFilePath(host, file)).toBe(fs.realpathSync(file));
  });

  it("refuses a missing file", async () => {
    await expect(approvedFilePath(host, path.join(tmp, "gone.png"))).rejects.toThrow(
      /no such file/,
    );
  });

  it("refuses a directory", async () => {
    await expect(approvedFilePath(host, tmp)).rejects.toThrow(/not a regular file/);
  });

  it("refuses a symlink that replaced the file after approval", async () => {
    const target = path.join(tmp, "elsewhere.png");
    fs.writeFileSync(target, "x");
    const file = path.join(tmp, "a.png");
    fs.symlinkSync(target, file);
    await expect(approvedFilePath(host, file)).rejects.toThrow();
  });

  it("refuses a directory in the spelling that became a symlink", async () => {
    const realDir = path.join(tmp, "real");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "a.png"), "x");
    const linkDir = path.join(tmp, "link");
    fs.symlinkSync(realDir, linkDir);
    await expect(approvedFilePath(host, path.join(linkDir, "a.png"))).rejects.toThrow();
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

  it("returns the bytes of a regular file", async () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, "png bytes");
    expect(new TextDecoder().decode(await approvedFileBytes(host, file, 100))).toBe("png bytes");
  });

  it("refuses a file over the limit before reading it", async () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, "0123456789");
    await expect(approvedFileBytes(host, file, 9)).rejects.toThrow(
      `${file} is 10 bytes; the most this reads is 9.`,
    );
  });

  it("refuses a symlink, a missing file, and a directory", async () => {
    const target = path.join(tmp, "elsewhere.png");
    fs.writeFileSync(target, "x");
    fs.symlinkSync(target, path.join(tmp, "link.png"));
    await expect(approvedFileBytes(host, path.join(tmp, "link.png"), 100)).rejects.toThrow();
    await expect(approvedFileBytes(host, path.join(tmp, "gone.png"), 100)).rejects.toThrow(
      /no such file/,
    );
    await expect(approvedFileBytes(host, tmp, 100)).rejects.toThrow(/not a regular file/);
  });
});
