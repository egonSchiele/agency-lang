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
 * A path as bash hands it to the program it runs. Bash expands a leading
 * `~` only in an unquoted word, so the caller says which kind of word
 * this was. `~user` throws (see `expandPath`).
 */
export function expandTilde(target: string, tildeMode: TildeMode): string {
  if (tildeMode === "literal") {
    return target;
  }
  return expandPath(target, currentHost().system.homeDir());
}

/**
 * A path from a safeBash command, made absolute against safeBash's cwd.
 * No filesystem access. `refusal` names the caller in the message for an
 * empty cwd, which would otherwise resolve against the process's own.
 */
export function resolveAgainstCwd(
  target: string,
  cwd: string,
  tildeMode: TildeMode,
  refusal: string,
): string {
  if (cwd.trim() === "") {
    throw new Error(`${refusal} refused: cwd must not be empty.`);
  }
  const baseDir = resolveCwdPath(currentHost(), cwd);
  return path.resolve(baseDir, expandTilde(target, tildeMode));
}

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
  const absolute = resolveAgainstCwd(target, cwd, tildeMode, "redirect");
  const resolved = await currentHost().files.realDir(absolute);
  return { dir: path.dirname(resolved), filename: path.basename(resolved) };
}
