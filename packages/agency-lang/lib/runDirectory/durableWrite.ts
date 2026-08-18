import * as fs from "fs";
import * as path from "path";

import type { z } from "zod";

/**
 * Durable file writes for the run directory: an append that reaches the disk
 * before it returns, and a validated whole-file replace that a reader can
 * never see half of. Annotation logs, statelogs, checklist revisions and
 * labeling drafts all go through here.
 */

/**
 * Append and flush to disk before returning.
 *
 * `appendFileSync` returns once the write reaches the OS page cache, not the
 * device. Without the fsync, a power loss can lose an annotation the tool
 * already told the person was recorded — and a run directory exists precisely
 * because those judgements cannot be regenerated.
 */
export function appendDurably(filePath: string, line: string): void {
  const handle = fs.openSync(filePath, "a");
  try {
    fs.writeSync(handle, line);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Flush a directory entry, so a rename or creation survives a power loss.
 *
 * Renaming is atomic with respect to readers, but the directory entry itself
 * sits in cache until it is synced. Failures to open a directory for sync are
 * ignored: some platforms and filesystems refuse it, and that is not a reason
 * to fail a write that otherwise succeeded.
 */
export function syncDirectory(directoryPath: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directoryPath, "r");
    fs.fsyncSync(handle);
  } catch {
    // Directory fsync is unsupported on some platforms; the rename still
    // happened, and there is nothing further this layer can do about it.
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}

export type AtomicWriteArgs<Value> = {
  targetPath: string;
  value: Value;
  schema: z.ZodType<Value>;
};

/**
 * Validate, then replace a whole file atomically.
 *
 * A plain write truncates before it writes, so a crash part-way leaves a file
 * that is neither the old content nor the new. Writing a uniquely named
 * temporary and renaming means a reader always sees one or the other. The temp
 * name carries the pid so two processes cannot collide on it.
 */
export function atomicWriteValidated<Value>(args: AtomicWriteArgs<Value>): void {
  const validated = args.schema.parse(args.value);
  fs.mkdirSync(path.dirname(args.targetPath), { recursive: true });
  const temporaryPath = `${args.targetPath}.${process.pid}.tmp`;

  // Flush the temp file's contents before the rename: renaming a file whose
  // bytes are still in cache can publish an empty or partial file.
  const handle = fs.openSync(temporaryPath, "w");
  try {
    fs.writeSync(handle, `${JSON.stringify(validated, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporaryPath, args.targetPath);
    syncDirectory(path.dirname(args.targetPath));
  } catch (renameError) {
    // Report the cleanup failure alongside the real one rather than letting
    // either hide the other.
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `Failed to write ${args.targetPath} (${(renameError as Error).message}) and failed to ` +
          `remove ${temporaryPath} (${(cleanupError as Error).message})`,
      );
    }
    throw renameError;
  }
}
