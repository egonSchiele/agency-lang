import fs from "fs/promises";
import path from "path";
import { resolveDir } from "./resolveDir.js";
import { expandPath } from "./expandPath.js";

/**
 * Resolve a filename relative to a directory with security checks.
 * Rejects empty dir, absolute filenames, path traversal, and symlink escapes.
 *
 * Relative `dir` arguments are resolved against the *module directory*
 * (the directory of the compiled JS of the Agency module that initiated
 * this run), not `process.cwd()`. This matches what users want when
 * they ship a co-located resource bundle (`prompts/`, `fixtures/`, etc.)
 * next to their `.agency` file. Absolute `dir` arguments are unaffected
 * because `path.resolve` returns them unchanged. `~` and other
 * shorthand prefixes are expanded at the dir level via `resolveDir`
 * (which itself delegates to `expandPath`) — the `filename` argument
 * is NOT expanded because absolute / `~`-prefixed filenames are
 * rejected anyway.
 *
 * Outside an Agency execution frame, `resolveDir` falls back to
 * `process.cwd()`, preserving the previous behaviour for standalone
 * test invocations.
 */
export async function resolvePath(dir: string, filename: string): Promise<string> {
  if (!dir) {
    throw new Error(`dir must not be empty. Use "." for the current directory.`);
  }
  if (path.isAbsolute(filename) || filename.startsWith("~")) {
    throw new Error(`Filename must not be absolute when dir is specified (got "${filename}").`);
  }
  // Delegate the dir step to the shared `resolveDir` so `~` expansion
  // and any future path-policy rules apply uniformly. We pass `[]` for
  // `allowedPaths` here because `resolvePath` is the lower-level
  // helper — callers that need allow-list enforcement layer it on
  // separately (see e.g. the `_ls`/`_grep`/`_glob` call sites).
  const baseDir = await resolveDir(dir);
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
