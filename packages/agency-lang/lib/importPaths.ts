import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import picomatch from "picomatch";
import type { AgencyProgram } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Walk up from `startDir` looking for a sibling file named `filename`.
 *  Returns the absolute path of the first match, or `null` if no match is
 *  found before reaching the filesystem root. An optional `accept` predicate
 *  lets callers reject false-positive matches (e.g. a `package.json` with the
 *  wrong `name` field) and keep walking. */
export function findFileUp(
  startDir: string,
  filename: string,
  accept: (absPath: string) => boolean = () => true,
): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate) && accept(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Walk up from startDir until we find a directory containing package.json.
 *
 * If `packageName` is supplied, we only accept a package.json whose `name`
 * field equals that string — useful for callers that need to find a
 * specific package root (e.g. `agency-lang`) even when intermediate
 * directories above the starting point contain unrelated package.jsons
 * (workspaces, nested tooling configs, etc.).
 */
export function findPackageRoot(
  startDir: string,
  packageName?: string,
): string {
  const found = findFileUp(startDir, "package.json", (pkgJsonPath) => {
    if (packageName === undefined) {
      return true;
    }
    try {
      return JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")).name === packageName;
    } catch {
      /* unparseable package.json — keep walking */
      return false;
    }
  });
  if (found === null) {
    throw new Error(
      packageName
        ? `Could not find package root for '${packageName}' (no matching package.json found above ${startDir})`
        : "Could not find package root (no package.json found)",
    );
  }
  return path.dirname(found);
}

// Lazily resolve the package root so that bundled / packed outputs (which
// may live in a directory tree without any package.json above them) don't
// crash on module load. The failure is only surfaced when something actually
// asks for the stdlib or tests directory.
let _packageRoot: string | null = null;
function getPackageRoot(): string {
  if (_packageRoot === null) {
    _packageRoot = findPackageRoot(__dirname);
  }
  return _packageRoot;
}

/**
 * Returns the absolute path to the stdlib directory.
 */
export function getStdlibDir(): string {
  return path.join(getPackageRoot(), "stdlib");
}

/**
 * Stdlib modules that must NOT have the auto-import prelude
 * (`import { ... } from "std::index"`) prepended when parsed/compiled.
 *
 * - `index.agency` declares the very symbols the prelude imports, so
 *   wrapping it would be circular.
 * - `array.agency` re-exports those same auto-imported symbols from
 *   `std::index` for backward compatibility. A prelude-wrapped module
 *   cannot cleanly re-export a name the prelude also auto-imports (the
 *   generated `__registerTool(name)` would reference a re-export binding
 *   still in its temporal dead zone), so it must be left un-templated too.
 *
 * Centralized here because several parse/compile entry points each need
 * to make this per-file decision — keep them all going through this one
 * predicate rather than re-deriving `absPath === index.agency` inline.
 */
export function isNonTemplatedStdlib(absPath: string): boolean {
  const stdlibDir = getStdlibDir();
  return (
    absPath === path.join(stdlibDir, "index.agency") ||
    absPath === path.join(stdlibDir, "array.agency")
  );
}

/**
 * Returns the absolute path to the bundled agents directory, resolved relative
 * to this compiled module (`lib/agents` in dev, `dist/lib/agents` at runtime).
 */
export function getAgentsDir(): string {
  return path.join(__dirname, "agents");
}

/**
 * Returns all .agency files in the stdlib directory (recursively) as
 * absolute paths.
 */
export function getStdlibFiles(): string[] {
  const dir = getStdlibDir();
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".agency")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Map an absolute stdlib .agency file path to its `std::`-qualified module
 * name (POSIX-separated, no extension). e.g. `<stdlib>/ui/table.agency`
 * -> `std::ui/table`.
 */
export function stdlibModuleName(absPath: string): string {
  const rel = path.relative(getStdlibDir(), absPath).replace(/\.agency$/, "");
  return "std::" + rel.split(path.sep).join("/");
}

/**
 * Returns the absolute path to the tests directory.
 */
export function getTestDir(): string {
  return path.join(getPackageRoot(), "tests");
}

/**
 * Returns true if the import path is a standard library import (starts with "std::").
 */
export function isStdlibImport(importPath: string): boolean {
  return importPath.startsWith("std::");
}

/**
 * Classification of an import path. Used by ImportPolicy to allow / reject
 * imports by category.
 *
 *   - "stdlib" — `std::*` (e.g. `std::shell`)
 *   - "pkg"    — `pkg::*` (e.g. `pkg::wikipedia`)
 *   - "local"  — relative or absolute file paths (e.g. `./util.agency`)
 *   - "node"   — bare specifiers resolved by Node (e.g. `fs`, `child_process`)
 *
 * Order is load-bearing: stdlib and pkg are checked first so that a
 * `pkg::foo.agency` style path is never mis-classified as "local".
 */
export type ImportKind = "stdlib" | "pkg" | "local" | "node";

export function importKind(modulePath: string): ImportKind {
  if (isStdlibImport(modulePath)) return "stdlib";
  if (isPkgImport(modulePath)) return "pkg";
  if (
    modulePath.startsWith("./") ||
    modulePath.startsWith("../") ||
    modulePath.startsWith("/") ||
    modulePath.endsWith(".agency")
  ) {
    return "local";
  }
  return "node";
}

/**
 * Declarative import-allow-list / deny-list. Used by both `compileSource`
 * (to reject disallowed imports up front) and `_filterImports` in the
 * stdlib (to strip them from source).
 *
 * Semantics (see isImportAllowed):
 *   - Exclude rules always win: if a path matches anything in
 *     `excludedPackages` or `excludeKinds`, it is rejected.
 *   - When all four lists are empty, every import is allowed (default-allow).
 *   - When at least one allow list is non-empty, an import must match an
 *     allowed kind OR an allowed package glob (union across the two axes).
 */
export type ImportPolicy = {
  allowedPackages?: string[];
  excludedPackages?: string[];
  allowKinds?: ImportKind[];
  excludeKinds?: ImportKind[];
};

function matchGlob(pattern: string, value: string): boolean {
  return picomatch(pattern)(value);
}

export function isImportAllowed(modulePath: string, policy: ImportPolicy): boolean {
  const kind = importKind(modulePath);
  const allowKinds = policy.allowKinds ?? [];
  const allowPkgs = policy.allowedPackages ?? [];
  const excludeKinds = policy.excludeKinds ?? [];
  const excludePkgs = policy.excludedPackages ?? [];

  // Exclude rules — any match wins, regardless of allow rules.
  if (excludeKinds.includes(kind)) return false;
  if (excludePkgs.some((g) => matchGlob(g, modulePath))) return false;

  // No allow rules of either kind → default-allow.
  if (allowKinds.length === 0 && allowPkgs.length === 0) return true;

  // Union across the two axes: match either an allowed kind OR an
  // allowed package glob.
  const kindMatched = allowKinds.includes(kind);
  const pkgMatched = allowPkgs.some((g) => matchGlob(g, modulePath));
  return kindMatched || pkgMatched;
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
  return (
    importPath.endsWith(".agency") ||
    isStdlibImport(importPath) ||
    isPkgImport(importPath)
  );
}

export type AgencyImportTargetsOptions = {
  localOnly?: boolean;
};

/**
 * Return import paths that point at Agency modules from a parsed program.
 * Includes ordinary imports, `import node` statements, and re-exports.
 */
export function agencyImportTargets(
  program: AgencyProgram,
  options: AgencyImportTargetsOptions = {},
): string[] {
  const imports: string[] = [];
  for (const node of program.nodes) {
    let modulePath: string | null = null;
    if (node.type === "importStatement") {
      modulePath = node.modulePath;
    } else if (node.type === "importNodeStatement") {
      modulePath = node.agencyFile;
    } else if (node.type === "exportFromStatement") {
      modulePath = node.modulePath;
    }
    if (!modulePath || !isAgencyImport(modulePath)) continue;
    if (options.localOnly && !isLocalImportTarget(modulePath)) continue;
    imports.push(modulePath);
  }
  return imports;
}

function isLocalImportTarget(modulePath: string): boolean {
  return (
    importKind(modulePath) === "local" &&
    (
      modulePath.startsWith("./") ||
      modulePath.startsWith("../") ||
      modulePath.startsWith("/")
    )
  );
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
    throw new Error(
      `${context}: path must not contain backslashes ('${value}').`,
    );
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
    throw new Error(
      `Invalid pkg:: import "${importPath}": package specifier must not be empty.`,
    );
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
function findPkgDir(
  packageName: string,
  req: NodeRequire,
): {
  pkgJsonPath: string;
  pkgDir: string;
} {
  try {
    const pkgJsonPath = req.resolve(`${packageName}/package.json`);
    return { pkgJsonPath, pkgDir: path.dirname(pkgJsonPath) };
  } catch (e: any) {
    if (
      e?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
      e?.code === "MODULE_NOT_FOUND"
    ) {
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
  validatePkgRelativePath(
    normalizedEntry,
    `Package '${packageName}' has an invalid "agency" path`,
  );
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
    return path.join(
      getStdlibDir(),
      normalizeStdlibPath(importPath) + ".agency",
    );
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
 * - "std::foo"      -> relative path to <stdlib-dir>/foo.js from the source file
 * - "./foo.agency"  -> "./foo.js" (relative, just extension swap)
 *
 * @param fromFile - Absolute path of the source file containing the import.
 *   Used to compute relative paths for stdlib imports. If not provided,
 *   falls back to absolute paths.
 */
export function toCompiledImportPath(
  importPath: string,
  fromFile?: string,
): string {
  if (isStdlibImport(importPath)) {
    return "agency-lang/stdlib/" + normalizeStdlibPath(importPath) + ".js";
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
