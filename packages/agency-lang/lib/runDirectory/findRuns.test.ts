import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { childRunDirectories, findRunDirectories, isRunDirectory } from "./findRuns.js";
import { tempDir } from "./testFixtures.js";

function runDirAt(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "statelog.jsonl"), "");
  return dir;
}

describe("findRunDirectories", () => {
  it("a run directory is itself; a group yields its run-directory children, sorted, one level down", () => {
    const group = tempDir();
    const b = runDirAt(path.join(group, "b"));
    const a = runDirAt(path.join(group, "a"));
    fs.writeFileSync(path.join(group, "notes.txt"), "not a run");
    fs.mkdirSync(path.join(group, "empty-folder"));
    runDirAt(path.join(group, "deeper", "nested", "three")); // three levels down: not found

    expect(findRunDirectories([a])).toEqual([a]);
    expect(findRunDirectories([group])).toEqual([a, b]);
    expect(findRunDirectories([group, a])).toEqual([a, b, a]);
    expect(childRunDirectories(group)).toEqual([a, b]);
    expect(isRunDirectory(group)).toBe(false);
    expect(isRunDirectory(a)).toBe(true);
  });

  it("a test run as several trials is `<group>/<test>/<trial>`; trials sit beside flat runs, sorted", () => {
    const group = tempDir();
    const b = runDirAt(path.join(group, "b"));
    const a2 = runDirAt(path.join(group, "a", "2"));
    const a1 = runDirAt(path.join(group, "a", "1"));
    expect(findRunDirectories([group])).toEqual([a1, a2, b]);
  });

  it("never enters a suite's .staging directory, and goes no deeper than a trial", () => {
    const group = tempDir();
    runDirAt(path.join(group, ".staging", "a"));
    runDirAt(path.join(group, "a", "deeper", "1"));
    expect(() => findRunDirectories([group])).toThrow(/holds no run directories/);
  });

  it("refuses a missing path, a file, and a directory holding no run directories", () => {
    const folder = tempDir();
    fs.writeFileSync(path.join(folder, "statelogs.jsonl"), "");
    expect(() => findRunDirectories([path.join(folder, "missing")])).toThrow(/not a directory/);
    expect(() => findRunDirectories([path.join(folder, "statelogs.jsonl")])).toThrow(
      /not a directory/,
    );
    expect(() => findRunDirectories([folder])).toThrow(/holds no run directories.*runs add/s);
  });

  it("a child named statelog.jsonl does not make the group look like a run directory", () => {
    const group = tempDir();
    const child = runDirAt(path.join(group, "statelog.jsonl"));
    expect(isRunDirectory(group)).toBe(false);
    expect(findRunDirectories([group])).toEqual([child]);
  });

  it("returns absolute paths for a relative argument", () => {
    const group = tempDir();
    runDirAt(path.join(group, "a"));
    const relative = path.relative(process.cwd(), group);
    expect(findRunDirectories([relative])).toEqual([path.resolve(group, "a")]);
  });
});
