import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

// A program started as `node` runs whichever Node the PATH finds first, or
// fails when there is none: an app that carries its own Node has no `node`
// on the PATH of a shell it was opened from. `process.execPath` is the Node
// already running this code.
const NODE_BY_NAME = /(execFile(Sync|Async)?|spawn(Sync)?|exec)\(\s*["']node["']/;

const LIB = path.resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    const isSource = full.endsWith(".ts") || full.endsWith(".agency");
    const isTest = /\.test\.ts$/.test(full) || full.includes(`${path.sep}tests${path.sep}`);
    return isSource && !isTest ? [full] : [];
  });
}

function nodeByName(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      NODE_BY_NAME.test(line) ? [`${path.relative(LIB, file)}:${index + 1}`] : [],
    );
}

describe("starting Node", () => {
  it("nothing in lib/ starts node by name", () => {
    expect(sourceFiles(LIB).flatMap(nodeByName)).toEqual([]);
  });
});
