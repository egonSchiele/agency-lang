import * as fs from "fs";
import * as path from "path";

import { acquireStoreLock } from "../lock.js";
import { openStore } from "../store.js";

import { planMigration, type MigrationCounts } from "./plan.js";
import { readV1Store } from "./readV1.js";
import { copyChecklists, writeStagedStore } from "./write.js";

export class MigrationTargetError extends Error {}

export type MigrateStoreArgs = {
  sourceDir: string;
  destDir: string;
  reportWarning?(message: string): void;
  /** @internal Test-only interruption point, fired after the logs are written
   *  and before the manifest that makes the staged store readable. */
  faultBeforePublish?(): void;
};

export type MigrateResult = MigrationCounts & {
  sourceDir: string;
  destDir: string;
};

/** Marks a staging directory as ours, and says what it was for. Without it, a
 *  leftover directory is just an unexplained path we must not delete. */
type StagingMarker = {
  purpose: "agency-eval-label-migrate";
  sourceDir: string;
  destDir: string;
};

function stagingDirFor(destDir: string): string {
  return `${destDir}.migrating`;
}

function markerPath(stagingDir: string): string {
  return path.join(stagingDir, ".migration.json");
}

/** Exactly what `writeStagedStore` and its verification step create. Removal
 *  walks this list rather than the directory, so anything unexpected inside
 *  survives and makes the final rmdir fail loudly. */
const STAGED_FILES = [
  ".migration.json",
  "manifest.json",
  "outputs.jsonl",
  "occurrences.jsonl",
  "labels.jsonl",
  ".lock",
];
const STAGED_DIRECTORIES = ["checklists"];

/**
 * Reclaim a staging directory left behind by an interrupted run.
 *
 * Two independent safeguards, because deleting a directory is the most
 * destructive thing here. First a marker file must say this exact migration
 * created it. Then removal touches only the entries this code writes: if
 * anything else is present, the closing `rmdir` fails rather than taking an
 * unrelated file with it.
 *
 * `fs.rmSync(dir, { recursive: true })` on the whole path is deliberately not
 * used — a wrong `destDir` would then be unrecoverable.
 */
function reclaimStaging(stagingDir: string, expected: StagingMarker): void {
  if (!fs.existsSync(stagingDir)) {
    return;
  }
  let marker: StagingMarker | undefined;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath(stagingDir), "utf8")) as StagingMarker;
  } catch {
    marker = undefined;
  }
  if (
    marker?.purpose !== "agency-eval-label-migrate" ||
    marker.sourceDir !== expected.sourceDir ||
    marker.destDir !== expected.destDir
  ) {
    throw new MigrationTargetError(
      `${stagingDir} already exists and was not created by this migration. Move it aside and ` +
      "try again; refusing to delete a directory this command does not recognise.",
    );
  }

  for (const name of STAGED_FILES) {
    fs.rmSync(path.join(stagingDir, name), { force: true });
  }
  for (const name of STAGED_DIRECTORIES) {
    // Recursive only within a subdirectory this migration copied in whole.
    fs.rmSync(path.join(stagingDir, name), { recursive: true, force: true });
  }
  try {
    fs.rmdirSync(stagingDir);
  } catch (error) {
    throw new MigrationTargetError(
      `${stagingDir} still holds files this migration did not write, so it was left in place: ` +
      `${(error as Error).message}`,
    );
  }
}

/**
 * Rewrite a version 1 label store as version 2, somewhere new.
 *
 * Out of place on purpose: every output id changes, because identity moves from
 * the execution that produced a record to the record's own content. Rewriting
 * in place would change every id in a file the user may have copied or
 * scripted against, and "your labels moved but it is fine" is not a message
 * worth trusting to a one-line notice.
 */
export function migrateStore(args: MigrateStoreArgs): MigrateResult {
  const sourceDir = path.resolve(args.sourceDir);
  const destDir = path.resolve(args.destDir);

  if (!fs.existsSync(sourceDir)) {
    throw new MigrationTargetError(`Source store not found: ${args.sourceDir}`);
  }
  if (fs.existsSync(destDir)) {
    throw new MigrationTargetError(
      `${args.destDir} already exists. Migration writes a new store and never merges into an ` +
      "existing one; choose a path that does not exist yet.",
    );
  }

  const marker: StagingMarker = { purpose: "agency-eval-label-migrate", sourceDir, destDir };
  const stagingDir = stagingDirFor(destDir);

  // Hold the SOURCE lock for the whole read: an annotation appended midway
  // would be silently absent from the migrated store.
  const lock = acquireStoreLock({
    storeDir: sourceDir,
    reportWarning: args.reportWarning ?? ((message) => console.warn(message)),
  });
  try {
    const snapshot = readV1Store(sourceDir);
    const plan = planMigration(snapshot);

    reclaimStaging(stagingDir, marker);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(markerPath(stagingDir), JSON.stringify(marker));

    copyChecklists(sourceDir, stagingDir);
    args.faultBeforePublish?.();
    writeStagedStore(plan, stagingDir);

    // Prove the result opens through the ordinary read path before publishing
    // it. A store that only this code can read is not a migration.
    const verifyLock = acquireStoreLock({
      storeDir: stagingDir,
      reportWarning: args.reportWarning ?? (() => {}),
    });
    try {
      openStore({
        storeDir: stagingDir,
        lock: verifyLock,
        reportWarning: args.reportWarning ?? (() => {}),
      }).close();
    } finally {
      verifyLock.release();
    }
    fs.rmSync(markerPath(stagingDir), { force: true });
    fs.renameSync(stagingDir, destDir);

    return { ...plan.counts, sourceDir, destDir };
  } finally {
    lock.release();
  }
}
