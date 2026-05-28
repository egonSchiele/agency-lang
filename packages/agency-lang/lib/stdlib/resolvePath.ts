import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "../runtime/asyncContext.js";

/**
 * Resolve a filename relative to a directory with security checks.
 * Rejects empty dir, absolute filenames, path traversal, and symlink escapes.
 *
 * Relative `dir` arguments are resolved against the *module directory*
 * (the directory of the compiled JS of the Agency module that initiated
 * this run), not `process.cwd()`. This matches what users want when
 * they ship a co-located resource bundle (`prompts/`, `fixtures/`, etc.)
 * next to their `.agency` file. Absolute `dir` arguments are unaffected
 * because `path.resolve` returns them unchanged.
 *
 * Outside an Agency execution frame, `getModuleDir()` falls back to
 * `process.cwd()`, preserving the previous behaviour for standalone
 * test invocations.
 */
export async function resolvePath(dir: string, filename: string): Promise<string> {
  if (!dir) {
    throw new Error(`dir must not be empty. Use "." for the current directory.`);
  }
  if (path.isAbsolute(filename)) {
    throw new Error(`Filename must not be absolute when dir is specified (got "${filename}").`);
  }
  const baseDir = path.resolve(getModuleDir(), dir);
  const full = path.resolve(baseDir, filename);

  // Lexical check against the unresolved baseDir (catches .. early)
  if (!full.startsWith(baseDir + path.sep) && full !== baseDir) {
    throw new Error(`Filename "${filename}" escapes directory "${dir}".`);
  }

  // Always resolve the real base directory (handles symlinked dirs)
  let realBase: string;
  try {
    realBase = await fs.realpath(baseDir);
  } catch {
    realBase = baseDir;
  }

  // Resolve the target file if it exists
  let realFull: string;
  try {
    realFull = await fs.realpath(full);
  } catch {
    // File doesn't exist yet — construct expected real path and check containment
    const relFromBase = path.relative(baseDir, full);
    realFull = path.resolve(realBase, relFromBase);
  }

  if (!realFull.startsWith(realBase + path.sep) && realFull !== realBase) {
    throw new Error(`Filename "${filename}" resolves outside directory "${dir}" via symlink.`);
  }
  return full;
}
