import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findPackageRoot,
  findFileUp,
  resolveAgencyImportPath,
  getStdlibDir,
  toCompiledImportPath,
  isPkgImport,
  isAgencyImport,
  agencyImportTargets,
  parsePkgImport,
  resolvePkgAgencyPath,
} from "./importPaths.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseAgency } from "./parser.js";
import { CompileStrategy, RunStrategy } from "./importStrategy.js";
import { SymbolTable } from "./symbolTable.js";

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
  it("should convert std:: paths to package-absolute paths", () => {
    const result = toCompiledImportPath("std::math");
    expect(result).toBe("agency-lang/stdlib/math.js");
  });

  it("should convert relative .agency paths to .js", () => {
    const result = toCompiledImportPath("./utils.agency");
    expect(result).toBe("./utils.js");
  });

  it("should handle std:: paths with subdirectories", () => {
    const result = toCompiledImportPath("std::collections/queue");
    expect(result).toBe("agency-lang/stdlib/collections/queue.js");
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

describe("agencyImportTargets", () => {
  it("returns Agency import edges from import, import node, and export-from statements", () => {
    const absoluteImport = path.join(os.tmpdir(), "absolute.agency");
    const parsed = parseAgency(`
import { helper } from "./helper.agency"
import { read } from "std::fs"
import { pkgHelper } from "pkg::helpers"
import { jsHelper } from "./helper.js"
import { bare } from "bare.agency"
import node { worker } from "../nodes/worker.agency"
export { prompt } from "./prompt.agency"
export * from "${absoluteImport}"
node main() {}
`, {}, false);
    if (!parsed.success) throw new Error(parsed.message ?? "parse failed");

    expect(agencyImportTargets(parsed.result)).toEqual([
      "./helper.agency",
      "std::fs",
      "pkg::helpers",
      "bare.agency",
      "../nodes/worker.agency",
      "./prompt.agency",
      absoluteImport,
    ]);
    expect(agencyImportTargets(parsed.result, { localOnly: true })).toEqual([
      "./helper.agency",
      "../nodes/worker.agency",
      "./prompt.agency",
      absoluteImport,
    ]);
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

describe("SymbolTable.build with std:: imports", () => {
  it("should resolve std:: imports and include their symbols", () => {
    // Create a temp file that imports from std::math
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-test-"));
    const tmpFile = path.join(tmpDir, "test.agency");
    fs.writeFileSync(
      tmpFile,
      'import { add } from "std::math"\nnode main() {\n  return add(1, 2)\n}\n',
    );

    const table = SymbolTable.build(tmpFile);
    const stdlibMathPath = path.join(getStdlibDir(), "math.agency");

    // The symbol table should contain entries for the stdlib file
    expect(table.has(stdlibMathPath)).toBe(true);
    expect(table.getFile(stdlibMathPath)?.["add"]).toMatchObject({
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

describe("SymbolTable.build with pkg:: imports", () => {
  it("should follow pkg:: imports and classify symbols", () => {
    const table = SymbolTable.build(FIXTURE_MAIN);
    const pkgIndexPath = path.join(FIXTURE_PKG_DIR, "index.agency");

    // The symbol table should contain the package's symbols
    expect(table.has(pkgIndexPath)).toBe(true);
    expect(table.getFile(pkgIndexPath)?.["double"]).toMatchObject({
      kind: "function",
      name: "double",
    });
    expect(table.getFile(pkgIndexPath)?.["greet"]).toMatchObject({
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
      const table = SymbolTable.build(tmpFile);
      const pkgFooPath = path.join(FIXTURE_PKG2_DIR, "foo.agency");

      expect(table.has(pkgFooPath)).toBe(true);
      expect(table.getFile(pkgFooPath)?.["square"]).toMatchObject({
        kind: "function",
        name: "square",
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("CompileStrategy", () => {
  const jsStrategy = new CompileStrategy({ targetExt: ".js" });
  const tsStrategy = new CompileStrategy({ targetExt: ".ts" });

  it("should rewrite .agency to .js", () => {
    expect(jsStrategy.rewriteImport("./foo.agency", "/src/main.agency")).toBe("./foo.js");
  });

  it("should rewrite .agency to .ts with --ts", () => {
    expect(tsStrategy.rewriteImport("./foo.agency", "/src/main.agency")).toBe("./foo.ts");
  });

  it("should leave .js imports untouched", () => {
    expect(jsStrategy.rewriteImport("./tools.js", "/src/main.agency")).toBe("./tools.js");
  });

  it("should leave .ts imports untouched", () => {
    expect(jsStrategy.rewriteImport("./tools.ts", "/src/main.agency")).toBe("./tools.ts");
  });

  it("should leave bare specifiers untouched", () => {
    expect(jsStrategy.rewriteImport("nanoid", "/src/main.agency")).toBe("nanoid");
  });
});

describe("RunStrategy", () => {
  const strategy = new RunStrategy();

  it("should rewrite .agency to .js", () => {
    expect(strategy.rewriteImport("./foo.agency", "/src/main.agency")).toBe("./foo.js");
  });

  it("should rewrite .ts to .js", () => {
    expect(strategy.rewriteImport("./tools.ts", "/src/main.agency")).toBe("./tools.js");
  });

  it("should leave .js imports as-is", () => {
    expect(strategy.rewriteImport("./tools.js", "/src/main.agency")).toBe("./tools.js");
  });

  it("should leave bare specifiers untouched", () => {
    expect(strategy.rewriteImport("nanoid", "/src/main.agency")).toBe("nanoid");
  });
});

describe("RunStrategy.prepareDependencies", () => {
  let tmpDir: string;
  const strategy = new RunStrategy();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-run-strategy-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should compile .ts to .js when .js doesn't exist", () => {
    const tsFile = path.join(tmpDir, "bar.ts");
    const jsFile = path.join(tmpDir, "bar.js");
    fs.writeFileSync(tsFile, "export const x: number = 1;");
    const fromFile = path.join(tmpDir, "main.agency");

    strategy.prepareDependencies(["./bar.js"], fromFile);

    expect(fs.existsSync(jsFile)).toBe(true);
    const content = fs.readFileSync(jsFile, "utf-8");
    expect(content).toContain("const x = 1");
  });

  it("should not overwrite existing .js files", () => {
    const jsFile = path.join(tmpDir, "bar.js");
    fs.writeFileSync(jsFile, "// original");
    const fromFile = path.join(tmpDir, "main.agency");

    strategy.prepareDependencies(["./bar.js"], fromFile);

    expect(fs.readFileSync(jsFile, "utf-8")).toBe("// original");
  });

  it("should throw when neither .js nor .ts exists", () => {
    const fromFile = path.join(tmpDir, "main.agency");

    expect(() => strategy.prepareDependencies(["./bar.js"], fromFile)).toThrow(
      /Cannot resolve import/,
    );
  });

  it("should skip bare specifiers", () => {
    const fromFile = path.join(tmpDir, "main.agency");

    // Should not throw — bare specifiers are skipped
    strategy.prepareDependencies(["nanoid"], fromFile);
  });
});

import { importKind, isImportAllowed } from "./importPaths.js";

describe("importKind", () => {
  it("classifies stdlib imports", () => {
    expect(importKind("std::shell")).toBe("stdlib");
    expect(importKind("std::index")).toBe("stdlib");
  });
  it("classifies pkg imports", () => {
    expect(importKind("pkg::wikipedia")).toBe("pkg");
  });
  it("classifies local imports (relative, absolute, .agency)", () => {
    expect(importKind("./foo.agency")).toBe("local");
    expect(importKind("../bar.agency")).toBe("local");
    expect(importKind("/abs/path/x.agency")).toBe("local");
    expect(importKind("something.agency")).toBe("local");
  });
  it("classifies bare specifiers as node", () => {
    expect(importKind("fs")).toBe("node");
    expect(importKind("child_process")).toBe("node");
    expect(importKind("nanoid")).toBe("node");
  });
  it("stdlib/pkg take precedence over .agency suffix", () => {
    // Hypothetical pkg::foo.agency must be classified as pkg, not local.
    expect(importKind("pkg::foo.agency")).toBe("pkg");
    expect(importKind("std::index.agency")).toBe("stdlib");
  });
});

describe("isImportAllowed", () => {
  it("empty policy → default-allow", () => {
    expect(isImportAllowed("fs", {})).toBe(true);
    expect(isImportAllowed("./local.agency", {})).toBe(true);
    expect(isImportAllowed("std::shell", {})).toBe(true);
  });
  it("excludeKinds wins over allowKinds", () => {
    expect(
      isImportAllowed("std::shell", {
        allowKinds: ["stdlib"],
        excludeKinds: ["stdlib"],
      }),
    ).toBe(false);
  });
  it("excludedPackages wins over allowedPackages", () => {
    expect(
      isImportAllowed("std::shell", {
        allowedPackages: ["std::*"],
        excludedPackages: ["std::shell"],
      }),
    ).toBe(false);
  });
  it("allowKinds=['stdlib'] only allows stdlib imports", () => {
    expect(isImportAllowed("std::shell", { allowKinds: ["stdlib"] })).toBe(true);
    expect(isImportAllowed("./bar.agency", { allowKinds: ["stdlib"] })).toBe(false);
    expect(isImportAllowed("fs", { allowKinds: ["stdlib"] })).toBe(false);
    expect(isImportAllowed("pkg::x", { allowKinds: ["stdlib"] })).toBe(false);
  });
  it("union: allowKinds + allowedPackages both pass", () => {
    const policy = { allowKinds: ["stdlib" as const], allowedPackages: ["pkg::wikipedia"] };
    expect(isImportAllowed("std::shell", policy)).toBe(true);
    expect(isImportAllowed("pkg::wikipedia", policy)).toBe(true);
    expect(isImportAllowed("pkg::other", policy)).toBe(false);
    expect(isImportAllowed("./bar.agency", policy)).toBe(false);
  });
  it("glob matching: std::* covers all stdlib paths", () => {
    expect(isImportAllowed("std::shell", { allowedPackages: ["std::*"] })).toBe(true);
    expect(isImportAllowed("std::index", { allowedPackages: ["std::*"] })).toBe(true);
    expect(isImportAllowed("./foo.agency", { allowedPackages: ["std::*"] })).toBe(false);
  });
  it("unknown kind strings in allowKinds match nothing", () => {
    // With a non-empty allow list, all imports must match SOMETHING. Unknown
    // kind strings can never match → all imports get rejected.
    const policy = { allowKinds: ["bogus" as never] };
    expect(isImportAllowed("std::shell", policy)).toBe(false);
    expect(isImportAllowed("fs", policy)).toBe(false);
  });
});

describe("findFileUp", () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fu-"))); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns the path of the nearest matching file, walking up", () => {
    const nested = path.join(dir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    const marker = path.join(dir, "agency.json");
    fs.writeFileSync(marker, "{}");
    expect(findFileUp(nested, "agency.json")).toBe(marker);
  });
  it("accepts a predicate so callers can match more than 'file exists'", () => {
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wrong" }));
    fs.writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "right" }));
    const found = findFileUp(nested, "package.json", (p) => {
      try { return JSON.parse(fs.readFileSync(p, "utf-8")).name === "right"; }
      catch { return false; }
    });
    expect(found).toBe(path.join(nested, "package.json"));
  });
  it("returns null when nothing matches", () => {
    expect(findFileUp(dir, "definitely-not-a-real-file.xyz")).toBeNull();
  });
});
