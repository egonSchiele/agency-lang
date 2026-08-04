import * as fs from "fs";
import * as path from "path";

import { syncDirectory } from "../jsonl.js";
import { acquireStoreLock } from "../lock.js";
import { openStore } from "../store.js";

import { planMigration, type MigrationCounts } from "./plan.js";
import { readV1Store } from "./readV1.js";
import {
  copyInventory,
  inventoryChecklists,
  markerMatches,
  markerPath,
  MARKER_PURPOSE,
  readMarker,
  removeStaging,
  stagingDirFor,
  writeMarker,
  type StagingMarker,
} from "./staging.js";
import { writeStagedStore } from "./write.js";

export class MigrationTargetError extends Error {}

export type MigrateStoreArgs = {
  sourceDir: string;
  destDir: string;
  reportWarning?(message: string): void;
  /** @internal Test-only interruption point, fired after the staging directory
   *  is claimed and before anything is copied into it. */
  faultBeforePublish?(): void;
};

export type MigrateResult = MigrationCounts & {
  sourceDir: string;
  destDir: string;
  /** True when the destination already held this migration's completed output,
   *  left unfinished by a crash between the rename and the marker's removal. */
  completedEarlierRun: boolean;
};

const NO_COUNTS: MigrationCounts = {
  oldRecords: 0,
  newRecords: 0,
  mergedGroups: 0,
  occurrences: 0,
  annotations: 0,
};

/**
 * Rewrite a version 1 label store as version 2, somewhere new.
 *
 * Out of place on purpose: every output id changes, because identity moves from
 * the execution that produced a record to the record's own content. Rewriting
 * in place would change every id in a file the user may have copied or scripted
 * against, and "your labels moved but it is fine" is not a message worth
 * trusting to a one-line notice.
 */
export function migrateStore(args: MigrateStoreArgs): MigrateResult {
  const sourceDir = path.resolve(args.sourceDir);
  const destDir = path.resolve(args.destDir);
  const warn = args.reportWarning ?? ((message: string) => console.warn(message));

  if (!fs.existsSync(sourceDir)) {
    throw new MigrationTargetError(`Source store not found: ${args.sourceDir}`);
  }

  if (fs.existsSync(destDir)) {
    // A destination carrying OUR marker is a publication interrupted after the
    // rename. Finishing it is the only correct move: the store is already
    // complete, and refusing would strand it.
    if (finishInterruptedPublication(sourceDir, destDir, warn)) {
      return { ...NO_COUNTS, sourceDir, destDir, completedEarlierRun: true };
    }
    throw new MigrationTargetError(
      `${args.destDir} already exists. Migration writes a new store and never merges into an ` +
      "existing one; choose a path that does not exist yet.",
    );
  }

  const stagingDir = stagingDirFor(destDir);

  // Hold the SOURCE lock for the whole read: an annotation appended midway
  // would be silently absent from the migrated store.
  const lock = acquireStoreLock({ storeDir: sourceDir, reportWarning: warn });
  try {
    const snapshot = readV1Store(sourceDir);
    const plan = planMigration(snapshot);
    const entries = inventoryChecklists(sourceDir);

    reclaimStaging(stagingDir, sourceDir, destDir);

    // The marker records what will be copied BEFORE any of it exists, so a
    // crash at any point leaves a directory reclaimable from that inventory
    // rather than from a source that may have moved on since.
    const marker: StagingMarker = { purpose: MARKER_PURPOSE, sourceDir, destDir, entries };
    writeMarker(stagingDir, marker);
    args.faultBeforePublish?.();

    copyInventory(sourceDir, stagingDir, entries);
    writeStagedStore(plan, stagingDir);

    // Prove the result opens through the ordinary read path before publishing
    // it. A store that only this code can read is not a migration.
    verifyStore(stagingDir, warn);

    // Publish, make the parent's new entry durable, and only then drop the
    // marker. Removing it first opens a window where a reboot leaves a complete
    // store nobody recognises.
    fs.renameSync(stagingDir, destDir);
    syncDirectory(path.dirname(destDir));
    fs.rmSync(markerPath(destDir), { force: true });
    syncDirectory(destDir);

    return { ...plan.counts, sourceDir, destDir, completedEarlierRun: false };
  } finally {
    lock.release();
  }
}

/** Reclaim a leftover staging directory, refusing anything this migration did
 *  not create. */
function reclaimStaging(stagingDir: string, sourceDir: string, destDir: string): void {
  if (!fs.existsSync(stagingDir)) {
    return;
  }
  const marker = readMarker(stagingDir);
  if (!markerMatches(marker, sourceDir, destDir)) {
    throw new MigrationTargetError(
      `${stagingDir} already exists and was not created by this migration. Move it aside and ` +
      "try again; refusing to delete a directory this command does not recognise.",
    );
  }
  removeStaging(stagingDir, marker as StagingMarker);
}

/**
 * Complete a publication interrupted between the rename and the marker's
 * removal.
 *
 * Only when the marker matches AND the store opens: a directory that merely
 * carries a marker but cannot be read is not something to declare finished.
 */
function finishInterruptedPublication(
  sourceDir: string,
  destDir: string,
  warn: (message: string) => void,
): boolean {
  const marker = readMarker(destDir);
  if (!markerMatches(marker, sourceDir, destDir)) {
    return false;
  }
  // The manifest is written LAST, so its presence is what distinguishes a
  // finished store from a directory that merely carries a marker. Checked
  // before opening, because `openStore` creates a manifest for an empty
  // directory and would otherwise declare it complete.
  if (!fs.existsSync(path.join(destDir, "manifest.json"))) {
    return false;
  }
  try {
    verifyStore(destDir, warn);
  } catch {
    return false;
  }
  fs.rmSync(markerPath(destDir), { force: true });
  syncDirectory(destDir);
  warn(
    `${destDir} already held a completed migration that was interrupted before it could be ` +
    "marked finished. Nothing was rewritten; the store is now published.",
  );
  return true;
}

function verifyStore(storeDir: string, warn: (message: string) => void): void {
  const lock = acquireStoreLock({ storeDir, reportWarning: warn });
  try {
    openStore({ storeDir, lock, reportWarning: warn }).close();
  } finally {
    lock.release();
  }
}
