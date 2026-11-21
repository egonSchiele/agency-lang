import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { currentHost } from "../runtime/currentHost.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { _removeRefusal, _realPathIn, _unparsedRemoveRefusal } from "./safeBashRemove.js";

// Nothing here deletes anything but a temp folder a test made: the
// functions only read path text and, for the real spelling, the filesystem.
describe("_removeRefusal", () => {
  const home = currentHost().system.homeDir();
  const cwd = currentHost().system.cwd();
  const sub = path.join(cwd, "lib");

  it.each([
    "/",
    "/*",
    "//",
    "/usr",
    "/usr/*",
    "~",
    "~/",
    "~/*",
    "$HOME",
    "$HOME/*",
    "$BUILD/*",
    "$BUILD/",
    home,
    `${home}/`,
    path.dirname(home),
    ".",
    "*",
    ".*",
    "..",
    "../*",
    "../..",
    cwd,
  ])("refuses %s", async (target) => {
    expect(await _removeRefusal(target, cwd)).not.toBe("");
  });

  it.each([
    "build",
    "./build",
    "lib/stdlib/*.tmp",
    "/tmp/scratch/x.py",
    "$BUILD",
    "$BUILD/out",
    "~/project/tmp/file.txt",
    "",
  ])("allows %s", async (target) => {
    expect(await _removeRefusal(target, cwd)).toBe("");
  });

  it("refuses the folder safeBash is working in and the folders that hold it", async () => {
    expect(await _removeRefusal(".", sub)).not.toBe("");
    expect(await _removeRefusal("..", sub)).not.toBe("");
    expect(await _removeRefusal("stdlib", sub)).toBe("");
  });

  it("refuses a `..` after a symlink, and allows one after a real or missing folder", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rm-wall-"));
    try {
      fs.mkdirSync(path.join(root, "outside", "inner"), { recursive: true });
      fs.mkdirSync(path.join(root, "sub"));
      fs.symlinkSync(path.join(root, "outside", "inner"), path.join(root, "link"));
      expect(await _removeRefusal("link/../build", root)).toContain("follows the symlink");
      expect(await _removeRefusal("sub/../build", root)).toBe("");
      expect(await _removeRefusal("nope/../build", root)).toBe("");
    } finally {
      safeDeleteDirectoryWithin(root, fs.realpathSync(os.tmpdir()));
    }
  });

  // A glob or a variable may expand to a symlink, so a `..` after one is
  // refused without looking at the disk.
  it.each(["*/../me", "l*/../me", "$D/../me", "a/../l*/../me", "{a,link}/../me", "l?nk/../me"])(
    "refuses %s",
    async (target) => {
      expect(await _removeRefusal(target, cwd)).toContain("after a glob or a variable");
    },
  );

  it.each(["lib/../build/*.o", "lib/../$BUILD"])("allows %s", async (target) => {
    expect(await _removeRefusal(target, cwd)).toBe("");
  });

  it("says why", async () => {
    expect(await _removeRefusal("/", cwd)).toBe("that is the filesystem root");
    expect(await _removeRefusal("$X/*", cwd)).toBe("if $X is unset, that is the filesystem root");
    expect(await _removeRefusal("/usr", cwd)).toContain("top-level path");
  });
});

describe("_unparsedRemoveRefusal", () => {
  const cwd = currentHost().system.cwd();

  it.each([
    "rm -rf $BUILD/*",
    'rm -rf "${BUILD}"/*',
    "cd /tmp && rm -rf /",
    "ls; /bin/rm -rf ~/*",
    "rmdir /",
    "python - <<'EOF'\nprint(1)\nEOF\nrm -rf ..",
    "x=`rm -rf ~`",
    'sh -c "rm -rf /"',
    "sh -c 'rm -rf ~/*'",
    "rm -rf ${D}/../me",
  ])("refuses %s", async (source) => {
    expect(await _unparsedRemoveRefusal(source, cwd)).not.toBe("");
  });

  it.each([
    "rm -rf $BUILD/out/*.o",
    "rm -f build/*.o; ls /",
    "echo rm; ls /",
    "format / && echo done",
    "git rm --cached x",
  ])("allows %s", async (source) => {
    expect(await _unparsedRemoveRefusal(source, cwd)).toBe("");
  });
});

describe("_realPathIn", () => {
  const cwd = currentHost().system.cwd();

  it("resolves a relative operand against safeBash's folder", async () => {
    const real = await currentHost().files.realPath(path.join(cwd, "package.json"));
    expect(await _realPathIn("package.json", cwd, "expand", "rm")).toBe(real);
    expect(await _realPathIn("../package.json", path.join(cwd, "lib"), "expand", "rm")).toBe(real);
  });

  it("leaves a quoted tilde as a file name", async () => {
    expect(await _realPathIn("~", cwd, "literal", "rm")).toBe(path.join(cwd, "~"));
  });

  it("keeps the missing steps of a folder that mkdir -p would make, below a linked folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "safebash-realpath-"));
    try {
      const realRoot = await currentHost().files.realPath(root);
      fs.mkdirSync(path.join(root, "target"));
      fs.symlinkSync(path.join(root, "target"), path.join(root, "link"));
      expect(await _realPathIn("a/b/c", root, "expand", "mkdir")).toBe(
        path.join(realRoot, "a/b/c"),
      );
      expect(await _realPathIn("link/b/c", root, "expand", "mkdir")).toBe(
        path.join(realRoot, "target/b/c"),
      );
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), root);
    }
  });
});
