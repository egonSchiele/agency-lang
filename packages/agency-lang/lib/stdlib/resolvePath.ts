import path from "path";
import { resolveDir } from "./resolveDir.js";
import { expandPath } from "./expandPath.js";

/**
 * Resolve a filename relative to a directory. No containment is
 * enforced here: upward traversal and absolute filenames are allowed,
 * matching open() in other languages. The policy layer is the
 * allow-list (`assertContained`, layered on by callers that take
 * `allowedPaths`) and the approval interrupts raised by the stdlib
 * wrappers (`interrupt std::read` / `std::write` / `std::edit`).
 *
 * An absolute `filename` wins over `dir` (path.resolve semantics).
 * `~` expands in both arguments.
 */
export async function resolvePath(dir: string, filename: string): Promise<string> {
  if (!dir) {
    throw new Error(`dir must not be empty. Use "." for the current directory.`);
  }
  const baseDir = await resolveDir(dir);
  return path.resolve(baseDir, expandPath(filename));
}
