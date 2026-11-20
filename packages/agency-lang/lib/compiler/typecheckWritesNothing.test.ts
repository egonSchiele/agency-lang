import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { safeDeleteDirectoryWithin } from "../utils.js";
import { getEffectsFromSource, typeCheckSource } from "./typecheck.js";

// A source with no path is checked without a file. A program that calls
// std::agency typecheck at run time may have been started in a folder it
// cannot write, such as `/` for an app opened from Finder, and the check
// used to write the source under `<current folder>/.agency-tmp/` first.
describe("type-checking a source that has no path", () => {
  let folder = "";
  afterEach(() => {
    vi.restoreAllMocks();
    if (folder !== "") {
      safeDeleteDirectoryWithin(fs.realpathSync(os.tmpdir()), fs.realpathSync(folder));
    }
    folder = "";
  });

  const inAnEmptyFolder = (): string => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "agency-typecheck-"));
    vi.spyOn(process, "cwd").mockReturnValue(folder);
    return folder;
  };

  it("writes nothing under the current folder", () => {
    const cwd = inAnEmptyFolder();
    const report = typeCheckSource("node main(): number {\n  return 1 + 2\n}\n");
    expect(report.errors).toEqual([]);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("works when the current folder cannot be written", () => {
    const cwd = inAnEmptyFolder();
    fs.chmodSync(cwd, 0o500);
    try {
      const report = typeCheckSource('node main(): number {\n  return "one"\n}\n');
      expect(report.errors.length).toBeGreaterThan(0);
    } finally {
      fs.chmodSync(cwd, 0o700);
    }
  });

  it("still does not resolve a relative import", () => {
    const cwd = inAnEmptyFolder();
    fs.writeFileSync(
      path.join(cwd, "helper.agency"),
      "export def one(): number {\n  return 1\n}\n",
    );
    expect(() =>
      typeCheckSource('import { one } from "./helper.agency"\nnode main() {\n  return one()\n}\n'),
    ).toThrow();
  });

  it("reads effects the same way", () => {
    const cwd = inAnEmptyFolder();
    const effects = getEffectsFromSource(
      'export node main() {\n  const text = read("a.txt") catch ""\n  return text\n}\n',
    );
    expect(effects.main).toContain("std::read");
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});
