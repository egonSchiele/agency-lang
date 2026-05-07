import fs from "fs/promises";
import path from "path";
import process from "process";

/**
 * Resolve a filename relative to a directory with security checks.
 * Rejects empty dir, absolute filenames, path traversal, and symlink escapes.
 */
export async function resolvePath(dir: string, filename: string): Promise<string> {
  if (!dir) {
    throw new Error(`dir must not be empty. Use "." for the current directory.`);
  }
  if (path.isAbsolute(filename)) {
    throw new Error(`Filename must not be absolute when dir is specified (got "${filename}").`);
  }
  const baseDir = path.resolve(process.cwd(), dir);
  const full = path.resolve(baseDir, filename);
  // Lexical check first (catches .. before the file exists)
  if (!full.startsWith(baseDir + path.sep) && full !== baseDir) {
    throw new Error(`Filename "${filename}" escapes directory "${dir}".`);
  }
  // Resolve symlinks and recheck to prevent symlink-based escapes
  let realFull: string;
  try {
    realFull = await fs.realpath(full);
  } catch {
    // File doesn't exist yet (e.g. write) — lexical check is sufficient
    return full;
  }
  let realBase: string;
  try {
    realBase = await fs.realpath(baseDir);
  } catch {
    realBase = baseDir;
  }
  if (!realFull.startsWith(realBase + path.sep) && realFull !== realBase) {
    throw new Error(`Filename "${filename}" resolves outside directory "${dir}" via symlink.`);
  }
  return full;
}
