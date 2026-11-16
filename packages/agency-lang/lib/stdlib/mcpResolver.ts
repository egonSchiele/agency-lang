import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "#path";
import { globalNodeModulesRoots } from "../runtime/localProvider.js";
import { isPlainObject } from "../utils/isPlainObject.js";

const PKG = "@agency-lang/mcp";

// The conditions Node matches when `import()` resolves a package. mcpBridge.mjs
// loads the package with `import()`, so the entry found here must be the one
// `import()` would pick. `require.resolve` matches "require" instead, and
// rejects a package whose exports only list "import".
const IMPORT_CONDITIONS = ["node", "import", "module-sync", "node-addons", "default"];

/** Find the file `import("@agency-lang/mcp")` would load, searching: an
 *  explicit AGENCY_MCP_PATH override first, then the node_modules directories
 *  Node walks from agency-lang, then each global node_modules root (npm i -g /
 *  pnpm add -g). Null if the package is not installed in any of them. This
 *  only locates the file; mcpBridge.mjs imports it. agency-lang does not
 *  depend on the package, so a monorepo checkout finds it only through the
 *  override. */
export function resolveMcpEntry(): string | null {
  const override = process.env.AGENCY_MCP_PATH;
  if (override) {
    return override;
  }
  const localDirs = ancestorNodeModules(path.dirname(fileURLToPath(import.meta.url)));
  return firstEntry(localDirs) ?? firstEntry(globalNodeModulesRoots());
}

/** The node_modules directories `import()` searches for a bare name: one in
 *  `fromDir` and one in each directory above it. Not `require.resolve.paths`,
 *  which adds NODE_PATH; `import()` ignores NODE_PATH, and pnpm sets it to its
 *  hidden node_modules/.pnpm/node_modules when it runs a script. */
function ancestorNodeModules(fromDir: string): string[] {
  const dirs: string[] = [];
  let dir = fromDir;
  while (true) {
    dirs.push(path.join(dir, "node_modules"));
    const parent = path.dirname(dir);
    if (parent === dir) {
      return dirs;
    }
    dir = parent;
  }
}

export function isMcpAvailable(): boolean {
  return resolveMcpEntry() !== null;
}

/** Expose the resolved entry to mcpBridge.mjs via AGENCY_MCP_PATH so the bridge
 *  can import it even from a global node_modules. Idempotent. */
export function exposeResolvedMcpPath(): void {
  if (process.env.AGENCY_MCP_PATH) {
    return;
  }
  const entry = resolveMcpEntry();
  if (entry !== null) {
    process.env.AGENCY_MCP_PATH = entry;
  }
}

function firstEntry(nodeModulesDirs: string[]): string | null {
  for (const dir of nodeModulesDirs) {
    const entry = packageEntry(path.join(dir, PKG));
    if (entry !== null) {
      return entry;
    }
  }
  return null;
}

/** The file `import()` loads for the package in `pkgDir`, or null when the
 *  package is not there or names no entry for `import()`. */
function packageEntry(pkgDir: string): string | null {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }
  const pkgJson: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  if (!isPlainObject(pkgJson)) {
    return null;
  }
  const target =
    pkgJson.exports === undefined ? mainTarget(pkgJson.main) : rootExportTarget(pkgJson.exports);
  if (target === null) {
    return null;
  }
  const entry = path.join(pkgDir, target);
  return fs.existsSync(entry) ? entry : null;
}

function mainTarget(main: unknown): string {
  return typeof main === "string" ? main : "index.js";
}

/** The target of the "." subpath. `exports` is either a map of subpaths
 *  (keys starting with "."), or the "." target written directly: a string, an
 *  array, or an object of conditions. */
function rootExportTarget(exports: unknown): string | null {
  if (isPlainObject(exports) && Object.keys(exports).some((key) => key.startsWith("."))) {
    return conditionalTarget(exports["."]);
  }
  return conditionalTarget(exports);
}

/** Resolve a target the way Node does for `import()`: a string is the path;
 *  an array is tried in order; an object is a list of conditions, tried in
 *  the order written, skipping the ones `import()` does not match. */
function conditionalTarget(target: unknown): string | null {
  if (typeof target === "string") {
    return target.startsWith("./") ? target : null;
  }
  if (Array.isArray(target)) {
    for (const option of target) {
      const resolved = conditionalTarget(option);
      if (resolved !== null) {
        return resolved;
      }
    }
    return null;
  }
  if (isPlainObject(target)) {
    for (const condition of Object.keys(target)) {
      if (!IMPORT_CONDITIONS.includes(condition)) {
        continue;
      }
      const resolved = conditionalTarget(target[condition]);
      if (resolved !== null) {
        return resolved;
      }
    }
  }
  return null;
}
