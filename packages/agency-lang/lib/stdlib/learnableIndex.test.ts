import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { getStdlibDir, stdlibModuleName } from "../importPaths.js";
import { STDLIB_MODULES } from "./stdlibModules.data.js";

/**
 * The `learntest` brain points its model at this list. A line that names a
 * module that was renamed or removed sends the model to a file that is not
 * there, so each line is checked against the stdlib.
 */
const index = path.join(getStdlibDir(), "agents", "prompts", "learnable-tools.md");

function listedFiles(): string[] {
  return fs
    .readFileSync(index, "utf8")
    .split("\n")
    .filter((line) => /^\S+\.agency: /.test(line))
    .map((line) => line.slice(0, line.indexOf(": ")));
}

describe("learnable-tools.md", () => {
  it("lists at least one file", () => {
    expect(listedFiles().length).toBeGreaterThan(0);
  });

  it("lists only stdlib modules that export a function", () => {
    const missing = listedFiles().filter((file) => {
      const full = path.join(getStdlibDir(), file);
      const functions = STDLIB_MODULES[stdlibModuleName(full)] ?? [];
      return !fs.existsSync(full) || functions.length === 0;
    });
    expect(missing).toEqual([]);
  });

  it("has nothing but the opening sentence and the list", () => {
    const lines = fs.readFileSync(index, "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(listedFiles().length + 2);
  });
});
