import path from "node:path";
import process from "node:process";
import { assertContained } from "./assertContained.js";
import { expandPath } from "./expandPath.js";

/** The sync policy core: expand shorthands, resolve against cwd. The ONE
 *  home of "what does a relative path mean" — sync-only callers that cannot
 *  await `resolveDir` (e.g. `_readSkill`) use this instead of copying it. */
export function resolveCwdPath(target: string): string {
  return path.resolve(process.cwd(), expandPath(target));
}

/**
 * Resolve a directory argument the way every path-taking stdlib
 * function does:
 *
 *  1. Expand user shorthands (currently `~`, eventually env vars and
 *     normalization) via `expandPath`.
 *  2. Resolve against `process.cwd()`. A relative path always means
 *     "relative to where the program was run". Agency code that wants
 *     a path relative to its own file passes `__dirname`.
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
): Promise<string> {
  const root = resolveCwdPath(dir);
  await assertContained(root, allowedPaths, process.cwd());
  return root;
}
