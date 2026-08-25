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
  const entries = readTree(dir, "");
  const manifest = entries.map((entry) => `${entry.rel}\0${sha256Text(entry.content)}`).join("\n");
  const dirName = sha256Text(manifest);
  return {
    dirName,
    files: entries.map((entry) => ({ name: `${dirName}/${entry.rel}`, content: entry.content })),
  };
}

/** Files under `dir`, sorted by relative path with `/` separators. Symlinks
 *  are refused: a stored copy must not depend on what a link pointed at. */
function readTree(dir: string, prefix: string): { rel: string; content: string }[] {
  const out: { rel: string; content: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`graderFiles must not contain symlinks: ${full}`);
    }
    if (entry.isDirectory()) {
      out.push(...readTree(full, rel));
    } else if (entry.isFile()) {
      out.push({ rel, content: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
