import fs from "fs/promises";
import path from "path";
import process from "process";

/**
 * Assert that `target` resolves inside at least one of `allowedRoots`.
 *
 * Containment is checked **symlink-aware**: both `target` and each root
 * are resolved via `fs.realpath` before the prefix comparison, so a
 * symlink pointing outside an allowed root is rejected. Targets that do
 * not exist yet (e.g. the destination of a copy or write) are resolved
 * lexically against the realpath of their nearest existing ancestor.
 *
 * If `allowedRoots` is empty the function returns immediately — this is
 * the current "no restriction" semantics and is preserved on purpose
 * so that adding `assertContained` to a helper is purely additive: only
 * callers that pass an explicit `allowedPaths` get the tightened check.
 *
 * Throws an `Error` whose message names the offending target and the
 * configured roots.
 */
export async function assertContained(
  target: string,
  allowedRoots: string[],
): Promise<void> {
  if (allowedRoots.length === 0) return;
  if (target.trim() === "") {
    throw new Error("assertContained: target must not be empty");
  }

  const lexicalTarget = path.resolve(process.cwd(), target);
  const realTarget = await realpathOrLexicalAncestor(lexicalTarget);

  const realRoots: string[] = [];
  for (const root of allowedRoots) {
    if (root.trim() === "") continue;
    const lexicalRoot = path.resolve(process.cwd(), root);
    realRoots.push(await realpathOrSelf(lexicalRoot));
  }

  if (realRoots.length === 0) return;

  for (const realRoot of realRoots) {
    if (samePath(realTarget, realRoot)) return;
    if (realTarget.startsWith(realRoot + path.sep)) return;
  }

  throw new Error(
    `Path "${target}" is not under any of the allowed paths: ${allowedRoots.join(", ")}.`,
  );
}

/**
 * Resolve the real path of `p`. If `p` does not exist yet, walk up the
 * directory chain until we find an existing ancestor, resolve that, then
 * re-join the remaining relative tail. This is the same pattern
 * `resolvePath` uses for non-existent files.
 */
async function realpathOrLexicalAncestor(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // Walk up one segment at a time looking for an existing ancestor.
    let current = path.dirname(p);
    const tail: string[] = [path.basename(p)];
    while (current !== path.dirname(current)) {
      try {
        const real = await fs.realpath(current);
        return path.resolve(real, ...tail.reverse());
      } catch {
        tail.push(path.basename(current));
        current = path.dirname(current);
      }
    }
    return p;
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

function samePath(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
