import * as fs from "fs";
import * as path from "path";

import { syncDirectory } from "../jsonl.js";

export class StagingError extends Error {}

export const STAGING_MARKER_NAME = ".migration.json";

/** One thing this migration copied, recorded before the copy happens. */
export type StagedEntry = {
  /** Relative to the staging directory, forward slashes on every platform. */
  path: string;
  type: "file" | "dir";
};

/**
 * What a staging directory is, written before anything is copied into it.
 *
 * The entry list is the ONLY authority on what this migration owns. Re-deriving
 * it from the live source at reclaim time is unsound: the source is unlocked
 * between a crash and the retry, so a removed source path would leave its
 * staged copy permanently unreclaimable, and a newly added source path could
 * make an unrelated staged file look owned.
 */
export type StagingMarker = {
  purpose: "agency-eval-label-migrate";
  sourceDir: string;
  destDir: string;
  entries: StagedEntry[];
};

export const MARKER_PURPOSE: StagingMarker["purpose"] = "agency-eval-label-migrate";

/** Files the migration always writes at the top level of a staging directory. */
const ALWAYS_WRITTEN = [
  STAGING_MARKER_NAME,
  "manifest.json",
  "outputs.jsonl",
  "occurrences.jsonl",
  "labels.jsonl",
  ".lock",
];

export function stagingDirFor(destDir: string): string {
  return `${destDir}.migrating`;
}

export function markerPath(directory: string): string {
  return path.join(directory, STAGING_MARKER_NAME);
}

export function readMarker(directory: string): StagingMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(directory), "utf8")) as StagingMarker;
    return parsed.purpose === MARKER_PURPOSE ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function markerMatches(
  marker: StagingMarker | undefined,
  sourceDir: string,
  destDir: string,
): boolean {
  return marker !== undefined && marker.sourceDir === sourceDir && marker.destDir === destDir;
}

/**
 * Inventory the source checklists, refusing anything that is not a plain file
 * or directory.
 *
 * `lstat`, never `stat`: a symbolic link must be seen as a link. `cpSync`
 * preserves links by default, so a staged `checklists/shared -> /elsewhere`
 * would let a later cleanup delete files through it, outside the staging
 * directory entirely. Refusing is better than silently dereferencing, which
 * would change what the migrated store contains.
 */
export function inventoryChecklists(sourceDir: string): StagedEntry[] {
  const checklistsRoot = path.join(sourceDir, "checklists");
  if (!fs.existsSync(checklistsRoot)) {
    return [];
  }
  const entries: StagedEntry[] = [{ path: "checklists", type: "dir" }];

  const walk = (relative: string): void => {
    const absolute = path.join(checklistsRoot, relative);
    for (const name of fs.readdirSync(absolute).slice().sort()) {
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const stats = fs.lstatSync(path.join(absolute, name));
      if (stats.isSymbolicLink()) {
        throw new StagingError(
          `${path.join(checklistsRoot, childRelative)} is a symbolic link. Migration copies ` +
          "checklists literally and will not follow links, because a link in the copy would " +
          "let cleanup reach outside the store. Replace it with a real file or directory.",
        );
      }
      if (stats.isDirectory()) {
        entries.push({ path: `checklists/${childRelative}`, type: "dir" });
        walk(childRelative);
        continue;
      }
      if (stats.isFile()) {
        entries.push({ path: `checklists/${childRelative}`, type: "file" });
        continue;
      }
      throw new StagingError(
        `${path.join(checklistsRoot, childRelative)} is neither a file nor a directory, so ` +
        "migration cannot copy it.",
      );
    }
  };
  walk("");
  return entries;
}

/** Write the marker and make it durable before anything else lands beside it.
 *  A marker that is not on disk is a staging directory nobody can reclaim. */
export function writeMarker(stagingDir: string, marker: StagingMarker): void {
  fs.mkdirSync(stagingDir, { recursive: true });
  const handle = fs.openSync(markerPath(stagingDir), "w");
  try {
    fs.writeSync(handle, `${JSON.stringify(marker, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  syncDirectory(stagingDir);
  syncDirectory(path.dirname(stagingDir));
}

/** Copy the inventoried entries and flush each one, so a power loss cannot
 *  publish a store whose checklists are missing or half-written. */
export function copyInventory(
  sourceDir: string,
  stagingDir: string,
  entries: readonly StagedEntry[],
): void {
  for (const entry of entries) {
    const to = path.join(stagingDir, entry.path);
    if (entry.type === "dir") {
      fs.mkdirSync(to, { recursive: true });
      continue;
    }
    const from = path.join(sourceDir, entry.path);
    const handle = fs.openSync(to, "w");
    try {
      fs.writeSync(handle, fs.readFileSync(from));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
  // Directories deepest first, so each is flushed after its children exist.
  for (const entry of [...entries].reverse()) {
    if (entry.type === "dir") {
      syncDirectory(path.join(stagingDir, entry.path));
    }
  }
}

/**
 * Remove a staging directory this migration created, and nothing else.
 *
 * Only paths named in the marker's inventory are touched, each checked with
 * `lstat` so a link is removed as a link rather than followed. Anything else
 * present survives and makes the final `rmdir` fail, which is reported rather
 * than forced.
 */
export function removeStaging(stagingDir: string, marker: StagingMarker): void {
  if (fs.lstatSync(stagingDir).isSymbolicLink()) {
    throw new StagingError(
      `${stagingDir} is a symbolic link, not a directory this migration created. Move it aside.`,
    );
  }

  for (const name of ALWAYS_WRITTEN) {
    removeLeaf(path.join(stagingDir, name));
  }
  // Deepest first: a directory can only go once its own entries have.
  const ordered = [...marker.entries].sort((left, right) => right.path.length - left.path.length);
  for (const entry of ordered) {
    const target = path.join(stagingDir, entry.path);
    if (entry.type === "dir") {
      removeOwnedDirectory(target);
      continue;
    }
    removeLeaf(target);
  }

  try {
    fs.rmdirSync(stagingDir);
  } catch (error) {
    throw new StagingError(
      `${stagingDir} still holds files this migration did not write, so it was left in place. ` +
      `Move it aside and try again. (${(error as Error).message})`,
    );
  }
}

/** Unlink a file or link. Never recursive, so it cannot reach through a link.
 *
 *  `rmSync` resolves a symlink to decide what it is removing and then refuses a
 *  directory, so a link pointing at a directory has to be unlinked directly. */
function removeLeaf(target: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    return;
  }
  fs.unlinkSync(target);
}

/** Remove a directory only if it is a real directory and is now empty. */
function removeOwnedDirectory(target: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    // Somebody replaced an inventoried directory with a link. Unlink the link
    // itself; do not follow it.
    fs.unlinkSync(target);
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }
  try {
    fs.rmdirSync(target);
  } catch {
    // Not empty: something unexpected is inside. Leave it, and let the caller's
    // rmdir of the staging root report the whole situation.
  }
}
