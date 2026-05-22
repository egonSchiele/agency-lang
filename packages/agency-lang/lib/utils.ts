import { Message } from "smoltalk";
import * as fs from "fs";
import * as path from "path";
import { findPackageRoot } from "@/importPaths.js";

export type SafeDeleteResult = {
  success: boolean;
  message?: string;
};

// Confirm `target` (already realpath-ed) lives strictly inside the
// realpath-ed project root for `target`. The trailing `+ path.sep` on the
// prefix prevents a sibling directory sharing a string prefix from passing.
// The project root is the nearest package.json walking up from `target`.
// If no package.json is found above `target`, refuse (target is loose in
// the filesystem with no project containing it).
function checkInsideProject(target: string): SafeDeleteResult | null {
  if (target === "/") {
    return {
      success: false,
      message: `Refusing to delete root dir`,
    };
  }
  let projectRoot: string;
  try {
    projectRoot = fs.realpathSync(findPackageRoot(path.dirname(target)));
  } catch (err) {
    return {
      success: false,
      message: `Refusing to delete '${target}': no project root found above it (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (target === projectRoot || !target.startsWith(projectRoot + path.sep)) {
    return {
      success: false,
      message: `Refusing to delete '${target}': outside project root '${projectRoot}'.`,
    };
  }
  return null;
}

function safeDelete(
  targetPath: string,
  kind: "file" | "directory",
  dryRun: boolean,
): SafeDeleteResult {
  if (!fs.existsSync(targetPath)) {
    return { success: false, message: `Path does not exist: '${targetPath}'.` };
  }
  const resolved = fs.realpathSync(path.resolve(targetPath));
  const stat = fs.statSync(resolved);
  const isFile = stat.isFile();
  const isDir = stat.isDirectory();
  if (kind === "file" && !isFile) {
    return { success: false, message: `Not a file: '${resolved}'.` };
  }
  if (kind === "directory" && !isDir) {
    return { success: false, message: `Not a directory: '${resolved}'.` };
  }
  const containment = checkInsideProject(resolved);
  if (containment) return containment;

  if (dryRun) {
    return { success: true, message: `[DRY RUN]: would have deleted ${resolved}` };
  }
  // Best-effort: callers often use this in `finally` blocks where a
  // throw would mask the real error or turn a clean exit into a crash.
  // `force: true` swallows ENOENT/permission errors that race against
  // the real delete; if anything else goes wrong, return the message
  // instead of propagating.
  try {
    if (kind === "file") fs.unlinkSync(resolved);
    else fs.rmSync(resolved, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      message: `Failed to delete '${resolved}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function safeDeleteFile(
  targetPath: string,
  dryRun: boolean = true,
): SafeDeleteResult {
  return safeDelete(targetPath, "file", dryRun);
}

export function safeDeleteDirectory(
  targetPath: string,
  dryRun: boolean = true,
): SafeDeleteResult {
  return safeDelete(targetPath, "directory", dryRun);
}

export function escape(str: string): string {
  return (
    str
      //.replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$")
  );
}

export function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function zip<T, U>(arr1: T[], arr2: U[]): Array<[T, U]> {
  const length = Math.min(arr1.length, arr2.length);
  const result: Array<[T, U]> = [];
  for (let i = 0; i < length; i++) {
    result.push([arr1[i], arr2[i]]);
  }
  return result;
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Like `uniq`, but de-duplicates by a derived key. The first occurrence
 * of each key is kept; later duplicates are dropped. Useful for de-duping
 * structured values where identity-based Set comparison wouldn't work
 * (e.g. compare-by-JSON.stringify).
 */
export function uniqBy<T, K>(arr: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Simple object check.
 */
export function isObject(item: any): boolean {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Deep merge two objects.
 */
export function mergeDeep(
  _objA: Record<string, any>,
  _objB: Record<string, any>,
): Record<string, any> {
  const objA = structuredClone(_objA);
  const objB = structuredClone(_objB);

  if (isObject(objA) && isObject(objB)) {
    for (const key in objB) {
      // console.log("key", key);
      if (isObject(objB[key])) {
        // console.log("is object!");
        if (!objA[key]) {
          // console.log("initializing", key);
          Object.assign(objA, { [key]: {} });
        } else if (!isObject(objA[key])) {
          // console.log("overwriting non-object key", key, "with object");
          Object.assign(objA, { [key]: {} });
        }
        objA[key] = mergeDeep(objA[key], objB[key]);
      } else {
        // console.log("setting", key, "to", objB[key]);
        Object.assign(objA, { [key]: objB[key] });
      }
    }
  }

  return objA;
}

export function round(num: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}