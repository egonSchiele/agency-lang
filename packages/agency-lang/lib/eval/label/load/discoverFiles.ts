import * as fs from "fs";
import * as path from "path";

import { IngestSourceError } from "./types.js";

/** One candidate file, already classified. Symlinks are carried through rather
 *  than dropped so the loader can report them as skips: silently omitting a
 *  file is how a batch ends up quietly short. */
export type DiscoveredFile = {
  absolutePath: string;
  /** Path relative to `root`, with forward slashes on every platform, so the
   *  same folder ingested from two working directories yields the same key. */
  itemKey: string;
  isSymlink: boolean;
};

export type FileSelection = {
  /** The single base every `itemKey` is relative to. */
  root: string;
  files: readonly DiscoveredFile[];
};

/**
 * List the files in a directory, sorted.
 *
 * Directories only. Patterns are deliberately unsupported: a glob engine is a
 * parser, and this one had grown a root-prefix rule, a Windows separator rule
 * and two bugs before it was removed. Selecting a subset of a directory is a
 * job for the shell, and the eligibility policy already skips what a broad
 * selection sweeps up.
 */
export function resolveFileSelection(source: string, recursive: boolean): FileSelection {
  const root = path.resolve(source);
  if (!fs.existsSync(root)) {
    throw new IngestSourceError(`Source not found: ${source}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new IngestSourceError(
      `${source} is a file, not a directory. Pass a directory of files, a run directory, or a ` +
        ".json file holding an array of strings.",
    );
  }
  return { root, files: walk(root, root, recursive) };
}

/** Sorted so ingest is deterministic: the order rows are written in is the
 *  order a labeling session presents them. */
function walk(root: string, dir: string, recursive: boolean): DiscoveredFile[] {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .slice()
    .sort((left, right) => compareNames(left.name, right.name));

  const found: DiscoveredFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.push({ absolutePath, itemKey: keyOf(root, absolutePath), isSymlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      if (recursive) {
        found.push(...walk(root, absolutePath, recursive));
      }
      continue;
    }
    if (entry.isFile()) {
      found.push({ absolutePath, itemKey: keyOf(root, absolutePath), isSymlink: false });
    }
  }
  return found;
}

/** Byte order, not locale order: `localeCompare` varies by machine, and ingest
 *  order decides the order a labeling session presents records in. */
function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function keyOf(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}
