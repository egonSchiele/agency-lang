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
 * below dir, throws before any interrupt exists. So does a `dir` that does
 * not exist, unless `dirMayBeMissing` is true: `write` passes it, because
 * it creates the folders it needs once the write is approved.
 *
 * The host's `locate` runs its steps in one piece: this runs between a
 * wrapper's call and its interrupt, and a real wait there would hand the
 * event loop to concurrent branches.
 */
export async function prepareContainedPath(
  dir: string,
  filename: string,
  operation: FileOperation,
  dirMayBeMissing: boolean = false,
): Promise<ContainedPath> {
  const host = currentHost();
  return host.files.locate(dir, filename, operation, dirMayBeMissing);
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
 * `resolveAgainstCwd` for a path bash will open as written. It refuses a
 * `..` that follows a symlink. `path.resolve` removes a `..` from the
 * text, while the kernel applies it after following the link: with `link`
 * pointing at `/elsewhere/inner`, `link/../creds` is `<cwd>/creds` to
 * `path.resolve` and `/elsewhere/creds` to `cat`. A payload built from
 * the first would name a file the command does not open.
 */
export async function resolveBashPath(
  target: string,
  cwd: string,
  tildeMode: TildeMode,
  refusal: string,
): Promise<string> {
  const absolute = resolveAgainstCwd(target, cwd, tildeMode, refusal);
  const expanded = expandTilde(target, tildeMode);
  const steps = expanded.split(path.sep);
  if (!steps.includes("..")) {
    return absolute;
  }
  let current = path.isAbsolute(expanded)
    ? path.parse(expanded).root
    : resolveCwdPath(currentHost(), cwd);
  for (const step of steps) {
    if (step === "" || step === ".") {
      continue;
    }
    if (step !== "..") {
      current = path.join(current, step);
      continue;
    }
    if (await isSymlink(current)) {
      throw new Error(
        `${refusal} refused: in "${target}" a ".." follows the symlink "${current}", and bash applies it to the folder the link points at.`,
      );
    }
    current = path.dirname(current);
  }
  return absolute;
}

/** Whether the last step of an absolute path is a symlink: followed all
 *  the way, it is then not its real parent plus its own name. `realDir`
 *  follows the last step, which `realPath` does not. A dangling link
 *  throws. */
async function isSymlink(absolute: string): Promise<boolean> {
  const parent = path.dirname(absolute);
  if (parent === absolute) {
    return false;
  }
  const files = currentHost().files;
  const real = await files.realDir(absolute);
  const realParent = await files.realDir(parent);
  return real !== path.join(realParent, path.basename(absolute));
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
  const absolute = await resolveBashPath(target, cwd, tildeMode, "redirect");
  const resolved = await currentHost().files.realDir(absolute);
  return { dir: path.dirname(resolved), filename: path.basename(resolved) };
}

/**
 * Where a path that does not exist yet would be, resolved the way a
 * redirect to it is, so a read of a file and a write of the same file name
 * one place. Throws unless nothing is there and the parent is a folder
 * that exists: the walk keeps every step after the first missing one as
 * written, so a missing parent would otherwise resolve too.
 */
export async function missingTarget(
  target: string,
  cwd: string,
  tildeMode: TildeMode,
): Promise<ContainedPath> {
  const where = await resolveRedirectTarget(target, cwd, tildeMode);
  const host = currentHost();
  const parent = await host.files.root(where.dir);
  if ((await host.files.stat(parent, "."))?.kind !== "dir") {
    throw new Error(`No folder at ${where.dir}.`);
  }
  if ((await host.files.stat(parent, where.filename)) !== null) {
    throw new Error(`${target} exists.`);
  }
  return where;
}
