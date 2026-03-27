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

/**
 * Returns the absolute path to the stdlib directory.
 */
export function getStdlibDir(): string {
  return STDLIB_DIR;
}

/**
 * Returns true if the import path is a standard library import (starts with "std::").
 */
export function isStdlibImport(importPath: string): boolean {
  return importPath.startsWith("std::");
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
    const stdlibPath = importPath.slice(5); // strip "std::"
    return path.join(STDLIB_DIR, stdlibPath + ".agency");
  }
  // Relative or other imports: resolve against the importing file's directory
  return path.resolve(path.dirname(fromFile), importPath);
}
