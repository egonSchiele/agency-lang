import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import { parseAgency } from "../parser.js";
import {
  manyFunctions,
  manyUnusedImports,
  manyRedundantPreludeImports,
  deepNesting,
  wideUnion,
  oneHugeFunction,
  multiFileProject,
} from "./fixtures.js";

function parses(source: string): boolean {
  return parseAgency(source, {}, false).success;
}

describe("perf fixtures parse and scale", () => {
  const stringGens: [string, (n: number) => string][] = [
    ["manyFunctions", (n) => manyFunctions(n)],
    ["manyFunctions(no docstrings)", (n) => manyFunctions(n, { docstrings: false })],
    ["manyUnusedImports", manyUnusedImports],
    ["manyRedundantPreludeImports", manyRedundantPreludeImports],
    ["deepNesting", deepNesting],
    ["wideUnion", wideUnion],
    ["oneHugeFunction", oneHugeFunction],
  ];

  for (const [name, gen] of stringGens) {
    it(`${name} produces parseable source that grows with n`, () => {
      expect(parses(gen(10))).toBe(true);
      expect(gen(20).length).toBeGreaterThan(gen(10).length);
    });
  }

  const createdDirs: string[] = [];
  afterAll(() => {
    for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("multiFileProject materializes a directory of n files", () => {
    const dir = multiFileProject(8);
    createdDirs.push(dir);
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".agency"));
    expect(files).toHaveLength(8);
    expect(parses(fs.readFileSync(`${dir}/file7.agency`, "utf-8"))).toBe(true);
  });
});
