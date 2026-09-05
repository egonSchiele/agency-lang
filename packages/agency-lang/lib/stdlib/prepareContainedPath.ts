import path from "path";
import { root, resolveUnder, stat } from "./contained.js";
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
 * Sync fs throughout (async signature kept so rejections stay
 * rejections): this runs between a wrapper's call and its interrupt, and
 * a real await there would hand the event loop to concurrent branches.
 */
export async function prepareContainedPath(
  dir: string,
  filename: string,
  operation: FileOperation,
): Promise<ContainedPath> {
  if (dir.trim() === "") {
    throw new Error(`${operation} refused: dir must not be empty.`);
  }
  const realRoot = root(dir);
  if (stat(realRoot, ".") === null) {
    throw new Error(`${operation} refused: dir "${dir}" does not exist.`);
  }
  let resolved: string;
  try {
    resolved = resolveUnder(realRoot, filename);
  } catch (error) {
    throw new Error(`${operation} ${teach(operation, (error as Error).message)}`);
  }
  return { dir: realRoot.real, filename: path.relative(realRoot.real, resolved) };
}

/** The escape message names the operation, so the model learns "to write
 *  somewhere else, pass that directory in dir" rather than a generic hint. */
function teach(operation: FileOperation, message: string): string {
  const preposition = operation === "write" ? "somewhere else" : "from somewhere else";
  return message.replace(
    "To reach it, pass that directory in dir.",
    `To ${operation} ${preposition}, pass that directory in dir.`,
  );
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
  if (cwd.trim() === "") {
    throw new Error("redirect refused: cwd must not be empty.");
  }
  const baseDir = resolveCwdPath(cwd);
  const expanded = tildeMode === "expand" ? expandPath(target) : target;
  const resolved = root(path.resolve(baseDir, expanded)).real;
  return { dir: path.dirname(resolved), filename: path.basename(resolved) };
}
