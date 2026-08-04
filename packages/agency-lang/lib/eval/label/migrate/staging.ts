import * as fs from "fs";
import * as path from "path";

import { z } from "zod";

import { syncDirectory } from "../jsonl.js";

export class StagingError extends Error {}

export const STAGING_MARKER_NAME = ".migration.json";

/** The only subtree this migration ever copies. */
const COPIED_ROOT = "checklists";

/** Files the migration always writes at the top level of a staging directory.
 *  The marker is handled separately: it must outlive every other removal. */
const ALWAYS_WRITTEN = [
  "manifest.json",
  "outputs.jsonl",
  "occurrences.jsonl",
  "labels.jsonl",
  ".lock",
];

/**
 * A path inside the staging directory, and nothing else.
 *
 * The marker is a file on disk that anything could have written, so its entries
 * are untrusted input. `{ path: "../precious" }` would otherwise resolve to a
 * sibling of the staging directory and be unlinked.
 */
function isConfinedPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes("\\") || path.posix.isAbsolute(candidate)) {
    return false;
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  if (path.posix.normalize(candidate) !== candidate) {
    return false;
  }
  return candidate === COPIED_ROOT || candidate.startsWith(`${COPIED_ROOT}/`);
}

export const StagedEntrySchema = z.object({
  path: z.string().refine(isConfinedPath, {
    message: `must be "${COPIED_ROOT}" or a normalized path beneath it, with no ".." segments`,
  }),
  type: z.enum(["file", "dir"]),
}).strict();

export type StagedEntry = z.infer<typeof StagedEntrySchema>;

/**
 * What a staging directory is, written before anything is copied into it.
 *
 * The entry list is the ONLY authority on what this migration owns. Re-deriving
 * it from the live source at reclaim time is unsound: the source is unlocked
 * between a crash and the retry, so a removed source path would leave its
 * staged copy permanently unreclaimable, and a newly added source path could
 * make an unrelated staged file look owned.
 */
export const StagingMarkerSchema = z.object({
  purpose: z.literal("agency-eval-label-migrate"),
  sourceDir: z.string().min(1),
  destDir: z.string().min(1),
  entries: z.array(StagedEntrySchema).refine(
    (entries) => new Set(entries.map((entry) => entry.path)).size === entries.length,
    { message: "entry paths must be unique" },
  ),
}).strict();

export type StagingMarker = z.infer<typeof StagingMarkerSchema>;

export const MARKER_PURPOSE: StagingMarker["purpose"] = "agency-eval-label-migrate";

export function stagingDirFor(destDir: string): string {
  return `${destDir}.migrating`;
}

export function markerPath(directory: string): string {
  return path.join(directory, STAGING_MARKER_NAME);
}

/** Parse a marker as untrusted data. An unparseable or malformed one is simply
 *  absent, which callers treat as "not ours". */
export function readMarker(directory: string): StagingMarker | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(markerPath(directory), "utf8"));
  } catch {
    return undefined;
  }
  const parsed = StagingMarkerSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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
 * `lstat` throughout, including on the root: `existsSync` follows links, so a
 * `checklists -> /external` would otherwise be inventoried straight through.
 * A symlink is refused rather than dereferenced, because silently turning a
 * link into a copy changes what the migrated store contains.
 */
export function inventoryChecklists(sourceDir: string): StagedEntry[] {
  const checklistsRoot = path.join(sourceDir, COPIED_ROOT);
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(checklistsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw new StagingError(
      `${checklistsRoot} is a symbolic link. Migration copies checklists literally and will not ` +
      "follow links, because a link in the copy would let cleanup reach outside the store.",
    );
  }
  if (!rootStats.isDirectory()) {
    throw new StagingError(`${checklistsRoot} is not a directory, so migration cannot copy it.`);
  }

  const entries: StagedEntry[] = [{ path: COPIED_ROOT, type: "dir" }];
  const walk = (relative: string): void => {
    const absolute = path.join(checklistsRoot, relative);
    for (const name of fs.readdirSync(absolute).slice().sort()) {
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const childPath = `${COPIED_ROOT}/${childRelative}`;
      const stats = fs.lstatSync(path.join(absolute, name));
      if (stats.isSymbolicLink()) {
        throw new StagingError(
          `${path.join(checklistsRoot, childRelative)} is a symbolic link. Migration copies ` +
          "checklists literally and will not follow links. Replace it with a real file or " +
          "directory.",
        );
      }
      if (stats.isDirectory()) {
        entries.push({ path: childPath, type: "dir" });
        walk(childRelative);
        continue;
      }
      if (stats.isFile()) {
        entries.push({ path: childPath, type: "file" });
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
    fs.writeSync(handle, `${JSON.stringify(StagingMarkerSchema.parse(marker), null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  syncDirectory(stagingDir);
  syncDirectory(path.dirname(stagingDir));
}

/**
 * Copy the inventoried entries and flush each one, so a power loss cannot
 * publish a store whose checklists are missing or half-written.
 *
 * Each source path is re-checked with `lstat` as it is read: a file replaced by
 * a symlink between inventory and copy must not be followed.
 */
export function copyInventory(
  sourceDir: string,
  stagingDir: string,
  entries: readonly StagedEntry[],
): void {
  for (const entry of entries) {
    const to = path.join(stagingDir, entry.path);
    const from = path.join(sourceDir, entry.path);
    const stats = fs.lstatSync(from);
    if (stats.isSymbolicLink()) {
      throw new StagingError(
        `${from} became a symbolic link while migration was running. Nothing was published.`,
      );
    }
    if (entry.type === "dir") {
      if (!stats.isDirectory()) {
        throw new StagingError(`${from} changed from a directory to a file while migrating.`);
      }
      fs.mkdirSync(to, { recursive: true });
      continue;
    }
    if (!stats.isFile()) {
      throw new StagingError(`${from} changed from a file to a directory while migrating.`);
    }
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
 * The walk descends from the staging root one component at a time, reading each
 * directory and `lstat`ing its direct children. That is what keeps it confined:
 * `lstat` only declines to follow the FINAL component of a path, so joining a
 * multi-segment relative path and checking the result would still resolve an
 * intermediate symlink and unlink a file outside staging. Descending never
 * enters a symlink, so no intermediate component can redirect it.
 *
 * The marker is removed LAST. Removing it first would leave an unmarked
 * half-cleaned directory that no later attempt could recognise, and so would
 * refuse forever.
 */
export function removeStaging(stagingDir: string, marker: StagingMarker): void {
  const rootStats = fs.lstatSync(stagingDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new StagingError(
      `${stagingDir} is not a directory this migration created. Move it aside and try again.`,
    );
  }

  const owned: Record<string, "file" | "dir"> = Object.create(null);
  for (const name of ALWAYS_WRITTEN) {
    owned[name] = "file";
  }
  for (const entry of marker.entries) {
    owned[entry.path] = entry.type;
  }

  removeOwnedChildren(stagingDir, "", owned);

  // Check BEFORE unlinking the marker, not after. Removing it and then failing
  // to rmdir would leave an unmarked half-cleaned directory that no later
  // attempt could recognise, and so would refuse forever.
  const remaining = fs.readdirSync(stagingDir)
    .filter((name) => name !== STAGING_MARKER_NAME);
  if (remaining.length > 0) {
    throw new StagingError(
      `${stagingDir} still holds ${remaining.length} entr${remaining.length === 1 ? "y" : "ies"} ` +
      `this migration did not write (${remaining.slice(0, 3).join(", ")}), so it was left in ` +
      "place. Move it aside and try again.",
    );
  }

  fs.unlinkSync(markerPath(stagingDir));
  fs.rmdirSync(stagingDir);
  syncDirectory(path.dirname(stagingDir));
}

function removeOwnedChildren(
  absoluteDir: string,
  relativeDir: string,
  owned: Readonly<Record<string, "file" | "dir">>,
): void {
  for (const name of fs.readdirSync(absoluteDir)) {
    const relative = relativeDir.length === 0 ? name : `${relativeDir}/${name}`;
    if (relative === STAGING_MARKER_NAME) {
      continue;
    }
    const absolute = path.join(absoluteDir, name);
    const stats = fs.lstatSync(absolute);
    const claim = owned[relative];

    if (stats.isSymbolicLink()) {
      // Owned as a link, or an owned entry replaced by one. Either way, unlink
      // the link itself and never look at where it points.
      if (claim !== undefined) {
        fs.unlinkSync(absolute);
      }
      continue;
    }
    if (stats.isDirectory()) {
      if (claim !== "dir") {
        continue;
      }
      removeOwnedChildren(absolute, relative, owned);
      try {
        fs.rmdirSync(absolute);
      } catch {
        // Something unowned is still inside. The staging root's rmdir will
        // report the whole situation.
      }
      continue;
    }
    if (claim === "file") {
      fs.unlinkSync(absolute);
    }
  }
}

/**
 * Whether a leftover directory is an empty staging shell.
 *
 * Covers the last crash window: the marker has been unlinked but the `rmdir`
 * that follows it did not run. Without this the directory is unmarked, so
 * nothing recognises it, and every future attempt refuses.
 */
export function isEmptyDirectory(directory: string): boolean {
  try {
    const stats = fs.lstatSync(directory);
    return !stats.isSymbolicLink() && stats.isDirectory() &&
      fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}
