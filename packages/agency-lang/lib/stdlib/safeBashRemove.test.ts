import path from "path";
import { describe, expect, it } from "vitest";
import { currentHost } from "../runtime/currentHost.js";
import { _removeRefusal, _removeTargetIn, _unparsedRemoveRefusal } from "./safeBashRemove.js";

// Nothing here deletes anything: both functions only read path text and,
// for the real spelling, the filesystem.
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

describe("_removeTargetIn", () => {
  const cwd = currentHost().system.cwd();

  it("resolves a relative operand against safeBash's folder", async () => {
    const real = await currentHost().files.realPath(path.join(cwd, "package.json"));
    expect(await _removeTargetIn("package.json", cwd, "expand")).toBe(real);
    expect(await _removeTargetIn("../package.json", path.join(cwd, "lib"), "expand")).toBe(real);
  });

  it("leaves a quoted tilde as a file name", async () => {
    expect(await _removeTargetIn("~", cwd, "literal")).toBe(path.join(cwd, "~"));
  });
});
