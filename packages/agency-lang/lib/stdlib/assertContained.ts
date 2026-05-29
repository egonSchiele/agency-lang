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
 * If `allowedRoots` is non-empty but every entry is an empty/whitespace
 * string, the call throws rather than silently degrading to "no
 * restriction". Otherwise a caller writing `allowedPaths: [""]` would
 * get the same wide-open behavior as `allowedPaths: []`, which we
 * explicitly do not want.
 *
 * Throws an `Error` whose message names the offending target and the
 * configured roots.
 */
export async function assertContained(
  target: string,
  allowedRoots: string[],
  baseDir: string = process.cwd(),
): Promise<void> {
  if (allowedRoots.length === 0) return;
  if (target.trim() === "") {
    throw new Error("assertContained: target must not be empty");
  }

  // Both target and roots are resolved against the same `baseDir`. For
  // absolute paths `path.resolve` returns them unchanged, so callers
  // that already pre-resolve their target only need to pick `baseDir`
  // so relative entries in `allowedRoots` match. Tools resolving paths
  // against the Agency module directory (see `_ls`/`_grep`/`_glob` and
  // `resolvePath`) should pass `getModuleDir()` so a relative entry in
  // `allowedPaths` sits in the same root as the data the tool is
  // operating on.
  const lexicalTarget = path.resolve(baseDir, target);
  const realTarget = await realpathOrLexicalAncestor(lexicalTarget);

  const realRoots: string[] = [];
  for (const root of allowedRoots) {
    if (root.trim() === "") continue;
    const lexicalRoot = path.resolve(baseDir, root);
    realRoots.push(await realpathOrSelf(lexicalRoot));
  }

  if (realRoots.length === 0) {
    // The caller asked for *some* restriction but every supplied entry
    // was unusable. Fail closed rather than open.
    throw new Error(
      `assertContained: allowedPaths was set (${JSON.stringify(allowedRoots)}) but contained no usable entries; refusing to fall back to unrestricted access.`,
    );
  }

  for (const realRoot of realRoots) {
    if (isContained(realTarget, realRoot)) return;
  }

  throw new Error(
    `Path "${target}" is not under any of the allowed paths: ${allowedRoots.join(", ")}.`,
  );
}

/**
 * Returns true iff `target` is the same path as `root` or sits inside
 * it. Uses `path.relative` so it works correctly when `root` is the
 * filesystem root (`/` or `C:\`) — in that case `realRoot + path.sep`
 * would become `//`/`C:\\` and a naive `startsWith` check would refuse
 * every descendant. Path comparison is case-insensitive on Windows.
 */
function isContained(target: string, root: string): boolean {
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  if (t === r) return true;
  const rel = path.relative(r, t);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  // Any leading `..` segment means we escaped.
  const segments = rel.split(path.sep);
  if (segments[0] === "..") return false;
  return true;
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
