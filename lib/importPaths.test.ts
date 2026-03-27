import { describe, it, expect } from "vitest";
import {
  findPackageRoot,
  resolveAgencyImportPath,
  getStdlibDir,
  toCompiledImportPath,
} from "./importPaths.js";
import { buildSymbolTable } from "./symbolTable.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("findPackageRoot", () => {
  it("should find the package root from a nested directory", () => {
    // __dirname is inside lib/, package root is one level up
    const root = findPackageRoot(__dirname);
    expect(root).toBe(path.resolve(__dirname, ".."));
    // Verify package.json exists there
    expect(
      require("fs").existsSync(path.join(root, "package.json")),
    ).toBe(true);
  });
});

describe("resolveAgencyImportPath", () => {
  it("should resolve relative imports against the importing file's directory", () => {
    const result = resolveAgencyImportPath(
      "./utils.agency",
      "/project/src/main.agency",
    );
    expect(result).toBe("/project/src/utils.agency");
  });

  it("should resolve std:: imports to the stdlib directory", () => {
    const result = resolveAgencyImportPath(
      "std::math",
      "/project/src/main.agency",
    );
    const root = findPackageRoot(__dirname);
    expect(result).toBe(path.join(root, "stdlib", "math.agency"));
  });

  it("should resolve std:: imports with subdirectories", () => {
    const result = resolveAgencyImportPath(
      "std::collections/queue",
      "/project/src/main.agency",
    );
    const root = findPackageRoot(__dirname);
    expect(result).toBe(
      path.join(root, "stdlib", "collections", "queue.agency"),
    );
  });

  it("should leave non-agency, non-std imports unchanged", () => {
    const result = resolveAgencyImportPath(
      "./utils.js",
      "/project/src/main.agency",
    );
    expect(result).toBe("/project/src/utils.js");
  });
});

describe("toCompiledImportPath", () => {
  it("should convert std:: paths to absolute .js paths in stdlib dir", () => {
    const result = toCompiledImportPath("std::math");
    expect(result).toBe(path.join(getStdlibDir(), "math.js"));
  });

  it("should convert relative .agency paths to .js", () => {
    const result = toCompiledImportPath("./utils.agency");
    expect(result).toBe("./utils.js");
  });

  it("should handle std:: paths with subdirectories", () => {
    const result = toCompiledImportPath("std::collections/queue");
    expect(result).toBe(path.join(getStdlibDir(), "collections", "queue.js"));
  });
});

describe("buildSymbolTable with std:: imports", () => {
  it("should resolve std:: imports and include their symbols", () => {
    // Create a temp file that imports from std::math
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-test-"));
    const tmpFile = path.join(tmpDir, "test.agency");
    fs.writeFileSync(
      tmpFile,
      'import { add } from "std::math"\nnode main() {\n  return add(1, 2)\n}\n',
    );

    const table = buildSymbolTable(tmpFile);
    const stdlibMathPath = path.join(getStdlibDir(), "math.agency");

    // The symbol table should contain entries for the stdlib file
    expect(table[stdlibMathPath]).toBeDefined();
    expect(table[stdlibMathPath]["add"]).toEqual({
      kind: "function",
      name: "add",
    });

    // Clean up
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  });
});
