import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compileAgencyOnly } from "./agencyOnlyCompile.js";
import { removeCompiledScriptDir } from "../runtime/ipc.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

const HELPER = "export def helperValue(): number { return 7 }\n";
const MAIN =
  'import { helperValue } from "./helper.agency"\nexport node main(): number { return helperValue() }\n';

describe("compileAgencyOnly", () => {
  test("a source importing a sibling .agency compiles and the script exists", () => {
    const dir = makeDir(".aoc-ok-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "main.agency"), MAIN);
      const result = compileAgencyOnly(path.join(dir, "main.agency"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(fs.existsSync(result.scriptPath)).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(result.scriptPath), "helper.js"))).toBe(true);
        removeCompiledScriptDir(result.scriptPath);
        expect(fs.existsSync(result.scriptPath)).toBe(false);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("a source importing fs is refused as data, with the diagnostic, and no script", () => {
    const dir = makeDir(".aoc-fs-");
    try {
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import fs from "fs"\nexport node main(): number { return 1 }\n',
      );
      const result = compileAgencyOnly(path.join(dir, "main.agency"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toMatch(/not Agency source/);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("a nested source keeps its place so its sibling import resolves", () => {
    const dir = makeDir(".aoc-nested-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "sub", "main.agency"), MAIN);
      // The source's own directory is the boundary, so "sub" is the root
      // here and the entry sits at that root.
      const result = compileAgencyOnly(path.join(dir, "sub", "main.agency"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(fs.existsSync(path.join(path.dirname(result.scriptPath), "helper.js"))).toBe(true);
        removeCompiledScriptDir(result.scriptPath);
      }
    } finally {
      cleanup(dir);
    }
  });
});
