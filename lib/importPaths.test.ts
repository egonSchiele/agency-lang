import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findPackageRoot,
  resolveAgencyImportPath,
  resolveFlexibleExtension,
  getStdlibDir,
  toCompiledImportPath,
  isPkgImport,
  isAgencyImport,
  parsePkgImport,
  resolvePkgAgencyPath,
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

describe("std:: import code generation", () => {
  it("generated import path should point to a .js file inside the stdlib dir", () => {
    const result = toCompiledImportPath("std::math");
    // Must be an absolute path ending with stdlib/math.js
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toMatch(/stdlib[/\\]math\.js$/);
    // The stdlib dir should exist
    expect(fs.existsSync(path.dirname(result))).toBe(true);
  });
});

describe("isPkgImport", () => {
  it("should return true for pkg:: paths", () => {
    expect(isPkgImport("pkg::toolbox")).toBe(true);
    expect(isPkgImport("pkg::toolbox/strings")).toBe(true);
    expect(isPkgImport("pkg::@myorg/toolbox")).toBe(true);
  });

  it("should return false for non-pkg paths", () => {
    expect(isPkgImport("std::math")).toBe(false);
    expect(isPkgImport("./utils.agency")).toBe(false);
    expect(isPkgImport("zod")).toBe(false);
  });
});

describe("isAgencyImport", () => {
  it("should return true for .agency files", () => {
    expect(isAgencyImport("./utils.agency")).toBe(true);
  });

  it("should return true for std:: imports", () => {
    expect(isAgencyImport("std::math")).toBe(true);
  });

  it("should return true for pkg:: imports", () => {
    expect(isAgencyImport("pkg::toolbox")).toBe(true);
  });

  it("should return false for JS/TS imports", () => {
    expect(isAgencyImport("zod")).toBe(false);
    expect(isAgencyImport("./utils.js")).toBe(false);
    expect(isAgencyImport("@anthropic/sdk")).toBe(false);
  });
});

describe("parsePkgImport", () => {
  it("should parse simple package name", () => {
    expect(parsePkgImport("pkg::toolbox")).toEqual({
      packageName: "toolbox",
      subpath: undefined,
    });
  });

  it("should parse package with subpath", () => {
    expect(parsePkgImport("pkg::toolbox/strings")).toEqual({
      packageName: "toolbox",
      subpath: "strings",
    });
  });

  it("should parse package with nested subpath", () => {
    expect(parsePkgImport("pkg::toolbox/utils/strings")).toEqual({
      packageName: "toolbox",
      subpath: "utils/strings",
    });
  });

  it("should parse scoped package", () => {
    expect(parsePkgImport("pkg::@myorg/toolbox")).toEqual({
      packageName: "@myorg/toolbox",
      subpath: undefined,
    });
  });

  it("should parse scoped package with subpath", () => {
    expect(parsePkgImport("pkg::@myorg/toolbox/strings")).toEqual({
      packageName: "@myorg/toolbox",
      subpath: "strings",
    });
  });

  it("should strip .agency extension from subpath", () => {
    expect(parsePkgImport("pkg::toolbox/strings.agency")).toEqual({
      packageName: "toolbox",
      subpath: "strings",
    });
  });

  it("should throw on empty specifier", () => {
    expect(() => parsePkgImport("pkg::")).toThrow(/must not be empty/);
  });

  it("should throw on incomplete scoped package", () => {
    expect(() => parsePkgImport("pkg::@scope")).toThrow(/scoped package must include a name/);
    expect(() => parsePkgImport("pkg::@scope/")).toThrow(/scoped package must include a name/);
  });

  it("should throw on path traversal in subpath", () => {
    expect(() => parsePkgImport("pkg::toolbox/../etc")).toThrow(/must not contain/);
    expect(() => parsePkgImport("pkg::toolbox/./foo")).toThrow(/must not contain/);
  });

  it("should throw on empty subpath segment", () => {
    expect(() => parsePkgImport("pkg::toolbox/")).toThrow(/must not be empty/);
    expect(() => parsePkgImport("pkg::toolbox/foo//bar")).toThrow(/must not contain/);
  });
});

describe("toCompiledImportPath for pkg::", () => {
  it("should produce bare specifier for top-level package", () => {
    expect(toCompiledImportPath("pkg::toolbox")).toBe("toolbox");
  });

  it("should produce bare specifier with .js for subpath", () => {
    expect(toCompiledImportPath("pkg::toolbox/strings")).toBe("toolbox/strings.js");
  });

  it("should handle scoped packages", () => {
    expect(toCompiledImportPath("pkg::@myorg/toolbox")).toBe("@myorg/toolbox");
  });

  it("should handle scoped packages with subpath", () => {
    expect(toCompiledImportPath("pkg::@myorg/toolbox/strings")).toBe("@myorg/toolbox/strings.js");
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
    expect(table[stdlibMathPath]["add"]).toMatchObject({
      kind: "function",
      name: "add",
    });

    // Clean up
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  });
});

// Integration tests using the fixture package at tests/pkg-imports/
const PKG_IMPORTS_DIR = path.resolve(__dirname, "..", "tests", "pkg-imports");
const FIXTURE_MAIN = path.join(PKG_IMPORTS_DIR, "main.agency");
const FIXTURE_PKG_DIR = path.join(PKG_IMPORTS_DIR, "node_modules", "test-agency-pkg");
const FIXTURE_PKG2_DIR = path.join(PKG_IMPORTS_DIR, "node_modules", "test-agency-pkg2");

describe("pkg:: resolution with fixture package", () => {
  it("should resolve pkg:: import to the .agency file in node_modules", () => {
    const result = resolvePkgAgencyPath("pkg::test-agency-pkg", FIXTURE_MAIN);
    expect(result).toBe(path.join(FIXTURE_PKG_DIR, "index.agency"));
  });

  it("should resolve via resolveAgencyImportPath as well", () => {
    const result = resolveAgencyImportPath("pkg::test-agency-pkg", FIXTURE_MAIN);
    expect(result).toBe(path.join(FIXTURE_PKG_DIR, "index.agency"));
  });

  it("should resolve subpath import without agency field in package.json", () => {
    const result = resolvePkgAgencyPath("pkg::test-agency-pkg2/foo", FIXTURE_MAIN);
    expect(result).toBe(path.join(FIXTURE_PKG2_DIR, "foo.agency"));
  });

  it("should throw if package has no agency field", () => {
    // Create a temp package without the "agency" field
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pkg-test-"));
    const nodeModules = path.join(tmpDir, "node_modules", "no-agency-field");
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, "package.json"),
      JSON.stringify({ name: "no-agency-field", version: "1.0.0" }),
    );
    const fromFile = path.join(tmpDir, "main.agency");
    fs.writeFileSync(fromFile, "");

    expect(() =>
      resolvePkgAgencyPath("pkg::no-agency-field", fromFile),
    ).toThrow(/does not have a valid "agency" field/);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("buildSymbolTable with pkg:: imports", () => {
  it("should follow pkg:: imports and classify symbols", () => {
    const table = buildSymbolTable(FIXTURE_MAIN);
    const pkgIndexPath = path.join(FIXTURE_PKG_DIR, "index.agency");

    // The symbol table should contain the package's symbols
    expect(table[pkgIndexPath]).toBeDefined();
    expect(table[pkgIndexPath]["double"]).toMatchObject({
      kind: "function",
      name: "double",
    });
    expect(table[pkgIndexPath]["greet"]).toMatchObject({
      kind: "function",
      name: "greet",
    });
  });

  it("should follow pkg:: subpath imports without agency field", () => {
    // Create a temp file that imports a subpath from test-agency-pkg2 (no "agency" field)
    const tmpFile = path.join(PKG_IMPORTS_DIR, "_test_subpath.agency");
    fs.writeFileSync(
      tmpFile,
      'import { square } from "pkg::test-agency-pkg2/foo"\nnode main() {\n  return square(5)\n}\n',
    );

    try {
      const table = buildSymbolTable(tmpFile);
      const pkgFooPath = path.join(FIXTURE_PKG2_DIR, "foo.agency");

      expect(table[pkgFooPath]).toBeDefined();
      expect(table[pkgFooPath]["square"]).toMatchObject({
        kind: "function",
        name: "square",
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("resolveFlexibleExtension", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-flex-ext-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return the resolved path when the file exists as-is", () => {
    const tsFile = path.join(tmpDir, "bar.ts");
    fs.writeFileSync(tsFile, "export const x = 1;");
    const fromFile = path.join(tmpDir, "main.agency");

    const result = resolveFlexibleExtension("./bar.ts", fromFile);
    expect(result).toBe(tsFile);
  });

  it("should fall back from .js to .ts when .js doesn't exist", () => {
    const tsFile = path.join(tmpDir, "bar.ts");
    fs.writeFileSync(tsFile, "export const x = 1;");
    const fromFile = path.join(tmpDir, "main.agency");

    const result = resolveFlexibleExtension("./bar.js", fromFile);
    expect(result).toBe(tsFile);
  });

  it("should fall back from .ts to .js when .ts doesn't exist", () => {
    const jsFile = path.join(tmpDir, "bar.js");
    fs.writeFileSync(jsFile, "export const x = 1;");
    const fromFile = path.join(tmpDir, "main.agency");

    const result = resolveFlexibleExtension("./bar.ts", fromFile);
    expect(result).toBe(jsFile);
  });

  it("should return null when neither .js nor .ts exists", () => {
    const fromFile = path.join(tmpDir, "main.agency");

    const result = resolveFlexibleExtension("./bar.js", fromFile);
    expect(result).toBeNull();
  });

  it("should return null for non-.js/.ts extensions", () => {
    const fromFile = path.join(tmpDir, "main.agency");

    const result = resolveFlexibleExtension("./bar.css", fromFile);
    expect(result).toBeNull();
  });

  it("should prefer the exact extension when both files exist", () => {
    const jsFile = path.join(tmpDir, "bar.js");
    const tsFile = path.join(tmpDir, "bar.ts");
    fs.writeFileSync(jsFile, "export const x = 1;");
    fs.writeFileSync(tsFile, "export const x = 1;");
    const fromFile = path.join(tmpDir, "main.agency");

    expect(resolveFlexibleExtension("./bar.js", fromFile)).toBe(jsFile);
    expect(resolveFlexibleExtension("./bar.ts", fromFile)).toBe(tsFile);
  });
});
