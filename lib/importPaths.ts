import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Walk up from startDir until we find a directory containing package.json.
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find package root (no package.json found)");
    }
    dir = parent;
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(__dirname);
const STDLIB_DIR = path.join(PACKAGE_ROOT, "stdlib");
const TEST_DIR = path.join(PACKAGE_ROOT, "tests");

/**
 * Returns the absolute path to the stdlib directory.
 */
export function getStdlibDir(): string {
  return STDLIB_DIR;
}

/**
 * Returns the absolute path to the tests directory.
 */
export function getTestDir(): string {
  return TEST_DIR;
}

/**
 * Returns true if the import path is a standard library import (starts with "std::").
 */
export function isStdlibImport(importPath: string): boolean {
  return importPath.startsWith("std::");
}

/**
 * Strip the "std::" prefix from a standard library import path.
 * If the path is not a std:: import, returns it unchanged.
 */
export function normalizeStdlibPath(importPath: string): string {
  if (isStdlibImport(importPath)) {
    return importPath.slice(5);
  }
  return importPath;
}

/**
 * Returns true if the import path is a package import (starts with "pkg::").
 */
export function isPkgImport(importPath: string): boolean {
  return importPath.startsWith("pkg::");
}

/**
 * Returns true if the import path points to Agency code that the compiler
 * should follow and process (relative .agency files, std:: imports, or pkg:: imports).
 */
export function isAgencyImport(importPath: string): boolean {
  return importPath.endsWith(".agency") || isStdlibImport(importPath) || isPkgImport(importPath);
}

/**
 * Strip the "pkg::" prefix from a package import path.
 * If the path is not a pkg:: import, returns it unchanged.
 */
export function normalizePkgPath(importPath: string): string {
  if (isPkgImport(importPath)) {
    return importPath.slice(5);
  }
  return importPath;
}

/**
 * Validate that a relative path within a package is safe: non-empty, no
 * backslashes, no absolute paths, no '..' or '.' or empty segments.
 * Used to validate both subpaths in import specifiers and the "agency" field
 * in package.json.
 */
function validatePkgRelativePath(value: string, context: string): void {
  if (!value) {
    throw new Error(`${context}: path must not be empty.`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`${context}: absolute paths are not allowed ('${value}').`);
  }
  if (value.includes("\\")) {
    throw new Error(`${context}: path must not contain backslashes ('${value}').`);
  }
  const segments = value.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) {
    throw new Error(
      `${context}: path must not contain empty, '.' or '..' segments ('${value}').`,
    );
  }
}

/**
 * Parse a pkg:: import into package name and optional subpath.
 * Validates that the specifier is well-formed and contains no path traversal.
 *
 * - "pkg::toolbox"                -> { packageName: "toolbox", subpath: undefined }
 * - "pkg::toolbox/strings"        -> { packageName: "toolbox", subpath: "strings" }
 * - "pkg::@scope/toolbox"         -> { packageName: "@scope/toolbox", subpath: undefined }
 * - "pkg::@scope/toolbox/strings" -> { packageName: "@scope/toolbox", subpath: "strings" }
 */
export function parsePkgImport(importPath: string): {
  packageName: string;
  subpath: string | undefined;
} {
  const bare = normalizePkgPath(importPath);
  if (!bare) {
    throw new Error(`Invalid pkg:: import "${importPath}": package specifier must not be empty.`);
  }

  let packageName: string;
  let subpath: string | undefined;

  if (bare.startsWith("@")) {
    const parts = bare.split("/");
    if (parts.length < 2 || !parts[1]) {
      throw new Error(
        `Invalid pkg:: import "${importPath}": scoped package must include a name, e.g. "@scope/name".`,
      );
    }
    packageName = parts.slice(0, 2).join("/");
    subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  } else {
    const slashIndex = bare.indexOf("/");
    if (slashIndex === -1) {
      packageName = bare;
      subpath = undefined;
    } else {
      packageName = bare.slice(0, slashIndex);
      subpath = bare.slice(slashIndex + 1);
    }
  }

  if (subpath !== undefined) {
    validatePkgRelativePath(subpath, `Invalid pkg:: import "${importPath}"`);
    // Strip .agency extension if present to avoid double extensions
    subpath = subpath.replace(/\.agency$/, "");
  }

  return { packageName, subpath };
}

/**
 * Find the package directory and package.json path for an npm package.
 * Tries resolving package.json directly first, falls back to resolving
 * the package entry and walking up if the package uses an exports map
 * that doesn't expose ./package.json.
 */
function findPkgDir(packageName: string, req: NodeRequire): {
  pkgJsonPath: string;
  pkgDir: string;
} {
  try {
    const pkgJsonPath = req.resolve(`${packageName}/package.json`);
    return { pkgJsonPath, pkgDir: path.dirname(pkgJsonPath) };
  } catch (e: any) {
    if (e?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || e?.code === "MODULE_NOT_FOUND") {
      const entryPath = req.resolve(packageName);
      const pkgDir = findPackageRoot(path.dirname(entryPath));
      const pkgJsonPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pkgJsonPath)) {
        throw new Error(
          `Could not locate package.json for package '${packageName}' starting from resolved entry '${entryPath}'.`,
        );
      }
      return { pkgJsonPath, pkgDir };
    }
    throw e;
  }
}

/**
 * Resolve a pkg:: import to an absolute filesystem path to the .agency file.
 * Uses createRequire rooted at the importing file's directory to find the
 * package via Node's module resolution, then reads its package.json "agency"
 * field for the entry point.
 */
export function resolvePkgAgencyPath(
  importPath: string,
  fromFile: string,
): string {
  const { packageName, subpath } = parsePkgImport(importPath);
  const req = createRequire(fromFile);
  const { pkgJsonPath, pkgDir } = findPkgDir(packageName, req);

  if (subpath) {
    const resolved = path.join(pkgDir, subpath + ".agency");
    // Verify the resolved path is still within the package directory
    if (!resolved.startsWith(pkgDir + path.sep) && resolved !== pkgDir) {
      throw new Error(
        `Import path '${importPath}' resolves to '${resolved}' which is outside the package directory '${pkgDir}'.`,
      );
    }
    return resolved;
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const agencyEntry = pkgJson.agency;
  if (!agencyEntry || typeof agencyEntry !== "string") {
    throw new Error(
      `Package '${packageName}' does not have a valid "agency" field in its package.json. ` +
      `This field should be a string pointing to the main .agency entry file.`,
    );
  }
  // Strip leading ./ (common in package.json paths) before validation
  const normalizedEntry = agencyEntry.replace(/^\.\//, "");
  validatePkgRelativePath(normalizedEntry, `Package '${packageName}' has an invalid "agency" path`);
  if (!agencyEntry.endsWith(".agency")) {
    throw new Error(
      `Package '${packageName}' has an "agency" path '${agencyEntry}' that does not end with ".agency".`,
    );
  }
  const resolved = path.resolve(pkgDir, agencyEntry);
  if (!resolved.startsWith(pkgDir + path.sep) && resolved !== pkgDir) {
    throw new Error(
      `Package '${packageName}' has an "agency" path '${agencyEntry}' which resolves outside ` +
      `the package directory '${pkgDir}'.`,
    );
  }
  return resolved;
}

/**
 * Resolve an Agency import path to an absolute filesystem path.
 *
 * - "std::foo"       -> <package-root>/stdlib/foo.agency
 * - "std::foo/bar"   -> <package-root>/stdlib/foo/bar.agency
 * - "pkg::toolbox"   -> <node_modules>/toolbox/<agency entry>.agency
 * - "pkg::toolbox/x" -> <node_modules>/toolbox/x.agency
 * - "./foo.agency"   -> resolved relative to the importing file
 * - "./foo.js"       -> resolved relative to the importing file (non-agency, kept as-is)
 */
export function resolveAgencyImportPath(
  importPath: string,
  fromFile: string,
): string {
  if (isStdlibImport(importPath)) {
    return path.join(STDLIB_DIR, normalizeStdlibPath(importPath) + ".agency");
  }
  if (isPkgImport(importPath)) {
    return resolvePkgAgencyPath(importPath, fromFile);
  }
  // Relative or other imports: resolve against the importing file's directory
  return path.resolve(path.dirname(fromFile), importPath);
}

/**
 * Convert an Agency import path to the path that should appear in generated
 * TypeScript import statements.
 *
 * - "std::foo"      -> absolute path to <stdlib-dir>/foo.js
 * - "./foo.agency"  -> "./foo.js" (relative, just extension swap)
 */
export function toCompiledImportPath(importPath: string): string {
  if (isStdlibImport(importPath)) {
    return path.join(STDLIB_DIR, normalizeStdlibPath(importPath) + ".js");
  }
  if (isPkgImport(importPath)) {
    // Emit bare specifier — Node resolves it at runtime via node_modules
    const { packageName, subpath } = parsePkgImport(importPath);
    if (subpath) {
      return `${packageName}/${subpath}.js`;
    }
    return packageName;
  }
  return importPath.replace(/\.agency$/, ".js");
}
