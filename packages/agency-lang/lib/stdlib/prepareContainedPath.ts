import path from "#path";
import { currentHost } from "../runtime/currentHost.js";
import { resolveCwdPath } from "./resolveDir.js";
import { expandPath } from "./expandPath.js";

export type ContainedPath = {
  dir: string;
  filename: string;
};

export type FileOperation = "read" | "write";

/**
 * Prepare a (dir, filename) pair for a single-file wrapper such as `read`
 * or `write`. The result feeds both the interrupt payload and the
 * operation, so both see the same spelling: `dir` is the real directory
 * and `filename` is the normalized relative path. An escape, or a symlink
 * below dir, throws before any interrupt exists.
 *
 * The host's `locate` runs its steps in one piece: this runs between a
 * wrapper's call and its interrupt, and a real wait there would hand the
 * event loop to concurrent branches.
 */
export async function prepareContainedPath(
  dir: string,
  filename: string,
  operation: FileOperation,
): Promise<ContainedPath> {
  const host = currentHost();
  return host.files.locate(dir, filename, operation);
}

export type TildeMode = "expand" | "literal";

/**
 * Where a safeBash redirect will land: the target resolved through the
 * strict walk and split into real parent plus name, so the payload's dir
 * is the destination the policy judges. No containment, because safeBash
 * has no trusted dir. tildeMode is quote-aware: unquoted expands, quoted
 * stays literal.
 */
export async function resolveRedirectTarget(
  target: string,
  cwd: string,
  tildeMode: TildeMode,
): Promise<ContainedPath> {
  const host = currentHost();
  if (cwd.trim() === "") {
    throw new Error("redirect refused: cwd must not be empty.");
  }
  const baseDir = resolveCwdPath(cwd);
  const expanded = tildeMode === "expand" ? expandPath(target) : target;
  const resolved = await host.files.realDir(path.resolve(baseDir, expanded));
  return { dir: path.dirname(resolved), filename: path.basename(resolved) };
}
