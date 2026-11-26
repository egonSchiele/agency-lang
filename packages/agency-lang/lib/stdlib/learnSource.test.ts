import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { getStdlibDir } from "../importPaths.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { learnSourceIn } from "./learnSource.js";

const stdlib = getStdlibDir();

describe("learnSourceIn", () => {
  let dir = "";
  let cwd = "";
  let home = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.cwd(), ".learn-source-"));
    cwd = path.join(dir, "work");
    home = path.join(dir, "home");
    fs.mkdirSync(cwd);
    fs.mkdirSync(home);
  });

  afterEach(() => {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
  });

  function write(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export def echo(text: string): string { return text }\n");
    return file;
  }

  function source(file: string, stdlibDir: string = stdlib): unknown {
    const result = learnSourceIn(file, cwd, home, stdlibDir);
    expect(result).toMatchObject({ success: true });
    return result.success ? result.value : null;
  }

  function error(file: string): string {
    const result = learnSourceIn(file, cwd, home, stdlib);
    expect(result.success).toBe(false);
    return result.success ? "" : String(result.error);
  }

  it("turns an absolute stdlib path into a module source", () => {
    expect(source(path.join(stdlib, "wikipedia.agency"))).toEqual({
      kind: "module",
      module: "std::wikipedia",
    });
  });

  it("keeps the folders of a nested stdlib path in the module name", () => {
    expect(source(path.join(stdlib, "data", "finance", "fred.agency"))).toEqual({
      kind: "module",
      module: "std::data/finance/fred",
    });
  });

  it("finds a relative path in the working directory", () => {
    write(path.join(cwd, "tools", "series.agency"));
    expect(source("tools/series.agency")).toEqual({
      kind: "file",
      dir: path.join(cwd, "tools"),
      filename: "series.agency",
    });
  });

  it("finds a relative path in the stdlib folder when the working directory has none", () => {
    expect(source("data/finance/fred.agency")).toEqual({
      kind: "module",
      module: "std::data/finance/fred",
    });
  });

  it("prefers the working directory when both have the file", () => {
    write(path.join(cwd, "wikipedia.agency"));
    expect(source("wikipedia.agency")).toEqual({
      kind: "file",
      dir: cwd,
      filename: "wikipedia.agency",
    });
  });

  it("turns an absolute path outside the stdlib folder into a file source", () => {
    const file = write(path.join(dir, "elsewhere", "chrome.agency"));
    expect(source(file)).toEqual({
      kind: "file",
      dir: path.join(dir, "elsewhere"),
      filename: "chrome.agency",
    });
  });

  it("refuses a file that is not an Agency file", () => {
    fs.writeFileSync(path.join(cwd, "notes.md"), "notes\n");
    expect(error("notes.md")).toContain("is not an Agency file");
  });

  it("names both places it looked for a missing relative path", () => {
    const message = error("missing/tool.agency");
    expect(message).toContain(path.join(cwd, "missing", "tool.agency"));
    expect(message).toContain(path.join(stdlib, "missing", "tool.agency"));
  });

  it("does not treat a sibling of the stdlib folder as part of it", () => {
    const fakeStdlib = path.join(dir, "stdlib");
    fs.mkdirSync(fakeStdlib);
    const file = write(path.join(dir, "stdlib-extra", "x.agency"));
    expect(source(file, fakeStdlib)).toEqual({
      kind: "file",
      dir: path.join(dir, "stdlib-extra"),
      filename: "x.agency",
    });
  });

  it("expands a leading ~ to the home folder", () => {
    write(path.join(home, "x.agency"));
    expect(source("~/x.agency")).toEqual({ kind: "file", dir: home, filename: "x.agency" });
  });
});
