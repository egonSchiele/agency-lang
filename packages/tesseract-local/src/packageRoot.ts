import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Walk up from startDir until we find a directory containing package.json.
 * Same shape as agency-lang's lib/importPaths.ts:findPackageRoot — kept inline
 * here so this package has no implementation dependency on agency-lang internals.
 * Don't replace with `path.join(__dirname, "..", "..")` — that breaks if tsc
 * outDir changes.
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find package root walking up from ${startDir} (no package.json)`,
      );
    }
    dir = parent;
  }
}
