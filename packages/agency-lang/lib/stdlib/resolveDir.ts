import path from "node:path";
import process from "node:process";
import { getModuleDir } from "../runtime/asyncContext.js";
import { assertContained } from "./assertContained.js";
import { expandPath } from "./expandPath.js";

/**
 * Resolve a directory argument the way every path-taking stdlib
 * function should:
 *
 *  1. Expand user shorthands (currently `~`, eventually env vars and
 *     normalization) via `expandPath`.
 *  2. Resolve against `base` (default: module dir) so a relative
 *     entry sits next to the Agency module that owns it. Shell-like
 *     callers (`_exec`/`_bash`) and fs-like callers (`_mkdir`/`_copy`/
 *     `_move`/`_remove`) pass `process.cwd()` because their relative
 *     paths should mean "the user's working directory" rather than
 *     "the module dir."
 *  3. Assert containment against `allowedPaths` so a policy can
 *     reject paths outside the allow-list.
 *
 * Returns the absolute, validated directory.
 *
 * Mirrors what `resolvePath(dir, filename)` does at the `dir` level.
 * If you're writing a new stdlib function that takes a `dir`-like
 * arg, USE THIS — don't re-implement the policy. Doing so encodes
 * the policy at one site, so future rules added to `expandPath` /
 * `resolveDir` propagate everywhere automatically.
 */
export async function resolveDir(
  dir: string,
  allowedPaths: string[] = [],
  base?: "moduleDir" | "cwd",
): Promise<string> {
  const expanded = expandPath(dir);
  const baseDir = base === "cwd" ? process.cwd() : getModuleDir();
  const root = path.resolve(baseDir, expanded);
  await assertContained(root, allowedPaths, baseDir);
  return root;
}
