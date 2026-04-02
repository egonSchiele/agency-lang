import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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
 * Resolve an Agency import path to an absolute filesystem path.
 *
 * - "std::foo"       -> <package-root>/stdlib/foo.agency
 * - "std::foo/bar"   -> <package-root>/stdlib/foo/bar.agency
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
  return importPath.replace(/\.agency$/, ".js");
}
