/** Copies a test's `graderFiles/` directory into the run directory, so the
 *  graders read the same answers days later, wherever the run is opened.
 *  The tree is stored whole under `graders/<sha256>/`, keeping its relative
 *  names, and that one name goes on the run row as `graderFiles`. */
import * as fs from "fs";
import * as path from "path";

import { sha256Text } from "@/utils/hash.js";

export type GraderFilesSnapshot = {
  /** Every file, named `<dirName>/<relative path>` for `recordCompletedRun`. */
  files: { name: string; content: string }[];
  /** The stored directory's name under `graders/`: a hash of every path and content. */
  dirName: string;
};

export function snapshotGraderFiles(dir: string): GraderFilesSnapshot {
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`graderFiles must not be a symlink: ${dir}`);
  }
  const entries = readTreeRefusingSymlinks(dir, "graderFiles");
  if (entries.length === 0) {
    throw new Error(`graderFiles is empty: ${dir}`);
  }
  const manifest = entries.map((entry) => `${entry.rel}\0${sha256Text(entry.content)}`).join("\n");
  const dirName = sha256Text(manifest);
  return {
    dirName,
    files: entries.map((entry) => ({ name: `${dirName}/${entry.rel}`, content: entry.content })),
  };
}

export type TreeEntry = { rel: string; content: string };

/** A file under the walked directory: its path relative to that directory
 *  with `/` separators, and its absolute path. */
export type TreeFile = { rel: string; full: string };

/** Files under `dir`, sorted by relative path, read as text. */
export function readTreeRefusingSymlinks(dir: string, what: string): TreeEntry[] {
  return walkTreeRefusingSymlinks(dir, what).map((file) => ({
    rel: file.rel,
    content: fs.readFileSync(file.full, "utf8"),
  }));
}

/** Files under `dir`, sorted by relative path with `/` separators. Symlinks
 *  are refused: a stored copy must not depend on what a link pointed at.
 *  `what` names the directory in the refusal ("graderFiles", "files"). */
export function walkTreeRefusingSymlinks(dir: string, what: string): TreeFile[] {
  return walkTree(dir, "", what);
}

function walkTree(dir: string, prefix: string, what: string): TreeFile[] {
  const out: TreeFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${what} must not contain symlinks: ${full}`);
    }
    if (entry.isDirectory()) {
      out.push(...walkTree(full, rel, what));
    } else if (entry.isFile()) {
      out.push({ rel, full });
    }
  }
  return out;
}

function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
